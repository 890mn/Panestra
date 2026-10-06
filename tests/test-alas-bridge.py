"""Standalone read-only ALAS bridge contracts; requires only Python's standard library."""
import contextlib
import asyncio
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

source = pathlib.Path(__file__).resolve().parents[1] / 'core' / 'adapters' / 'alas' / 'bridge.py'
spec = importlib.util.spec_from_file_location('panestra_alas_bridge', str(source))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class Console:
    def __init__(self, **kwargs):
        self.output = None
    @contextlib.contextmanager
    def capture(self):
        self.output = io.StringIO()
        yield types.SimpleNamespace(get=self.output.getvalue)
    def print(self, value):
        self.output.write(str(value))

class Manager:
    def __init__(self):
        self.state = 1
        self._process = types.SimpleNamespace(pid=123)
        self.renderables = ['Scheduler: Start task `Main`']

class BridgeContracts(unittest.TestCase):
    def test_route_is_read_only_loopback_authenticated_and_bound_to_original_root(self):
        class Response:
            def __init__(self, data, status_code=200, **kwargs):
                self.data, self.status_code = data, status_code
        class Route:
            def __init__(self, path, endpoint, methods):
                self.path, self.endpoint, self.methods = path, endpoint, methods
        application = types.SimpleNamespace(router=types.SimpleNamespace(routes=[]))
        fastapi = types.SimpleNamespace(asgi_app=lambda *args, **kwargs: application)
        managers = {'alas': Manager()}
        modules = {'starlette.responses': types.SimpleNamespace(JSONResponse=Response), 'starlette.routing': types.SimpleNamespace(Route=Route), 'module.webui': types.SimpleNamespace(fastapi=fastapi), 'module.webui.process_manager': types.SimpleNamespace(ProcessManager=types.SimpleNamespace(_processes=managers))}
        with tempfile.TemporaryDirectory() as root:
            configuration = {'root': root, 'secret': 'test-credential', 'bridgeId': 'test-bridge'}
            with patch.dict(sys.modules, modules), patch.object(bridge, 'read_configuration', return_value=configuration), patch.object(bridge, 'snapshot', return_value={'instances': []}) as snapshot:
                bridge.install('protected-file', root)
                fastapi.asgi_app()
                route = application.router.routes[0]
                self.assertEqual(route.path, '/panestra/status')
                self.assertEqual(route.methods, ['GET'])
                def request(host, credential):
                    return types.SimpleNamespace(client=types.SimpleNamespace(host=host), headers={'Authorization': credential})
                self.assertEqual(asyncio.run(route.endpoint(request('192.168.1.3', 'Bearer test-credential'))).status_code, 403)
                self.assertEqual(asyncio.run(route.endpoint(request('127.0.0.1', 'wrong'))).status_code, 401)
                self.assertEqual(snapshot.call_count, 0)
                result = asyncio.run(route.endpoint(request('127.0.0.1', 'Bearer test-credential')))
                self.assertEqual(result.status_code, 200)
                self.assertIs(snapshot.call_args[0][0], managers)
                configuration['bridgeId'] = 'different-installation'
                self.assertEqual(asyncio.run(route.endpoint(request('127.0.0.1', 'Bearer test-credential'))).status_code, 503)
            with patch.dict(sys.modules, modules), patch.object(bridge, 'read_configuration', return_value={'root': root + '-wrong', 'bridgeId': 'test-bridge'}):
                with self.assertRaises(ValueError):
                    bridge.install('protected-file', root)

    def test_snapshot_reads_only_loaded_instances_and_scheduler_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'alas.json'
            config = {'Main': {'Scheduler': {'Enable': True, 'Command': 'Main', 'NextRun': '2026-10-07 03:40:00'}, 'Secret': 'must-not-leak'}, 'Disabled': {'Scheduler': {'Enable': False, 'Command': 'Reward', 'NextRun': '2026-10-07 02:00:00'}}, 'Bad': {'Scheduler': {'Enable': True, 'Command': '../invalid', 'NextRun': 'invalid'}}}
            raw = json.dumps(config).encode('utf-8')
            file.write_bytes(raw)
            manager = Manager()
            with patch.dict(sys.modules, {'rich.console': types.SimpleNamespace(Console=Console)}):
                result = bridge.snapshot({'alas': manager}, directory)
                self.assertEqual(result['instances'][0]['currentTask'], 'Main')
                self.assertEqual(len(result['instances'][0]['tasks']), 1)
                self.assertNotIn('must-not-leak', json.dumps(result))
                manager.renderables.append('Scheduler: End task `Main`')
                manager.renderables.append('Wait until 2026-10-07 03:40:00 for task `Reward`')
                result = bridge.snapshot({'alas': manager}, directory)
                self.assertEqual(result['instances'][0]['currentTask'], '')
                self.assertEqual(result['instances'][0]['waitingTask'], 'Reward')
                manager._process.pid = 124
                manager.renderables = []
                self.assertEqual(bridge.snapshot({'alas': manager}, directory)['instances'][0]['waitingTask'], '')
                manager.state = 2
                manager.renderables.append('Scheduler: Start task `Main`')
                self.assertEqual(bridge.snapshot({'alas': manager}, directory)['instances'][0]['currentTask'], '')
                self.assertEqual(bridge.snapshot({}, directory)['instances'], [])
            self.assertEqual(file.read_bytes(), raw)

    def test_import_has_no_alas_startup_or_configuration_side_effects(self):
        self.assertNotIn('module.webui.setting', sys.modules)
        self.assertNotIn('module.webui.process_manager', sys.modules)

if __name__ == '__main__':
    unittest.main()
