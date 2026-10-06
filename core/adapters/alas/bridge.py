"""Read-only Panestra status route inside the real ALAS WebUI process.

Run this launcher instead of gui.py. Original task startup and reload settings
are preserved; no managers are created by status queries.
"""
import datetime
import json
import pathlib
import re
import weakref

_observations = weakref.WeakKeyDictionary()
_label = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")


def observe(manager):
    from rich.console import Console
    generation = getattr(getattr(manager, "_process", None), "pid", None)
    previous = _observations.get(manager)
    if previous is None or previous["generation"] != generation:
        previous = {"generation": generation, "last": None, "current": "", "waiting": ""}
        _observations[manager] = previous
    renderables = list(manager.renderables)[-400:]
    last = previous["last"]
    start = next((i + 1 for i, value in enumerate(renderables) if value is last), 0)
    console = Console(no_color=True, width=500)
    for renderable in renderables[start:]:
        with console.capture() as capture:
            console.print(renderable)
        line = capture.get()
        started = re.search(r"Scheduler: Start task `([A-Za-z0-9_-]{1,80})`", line)
        ended = re.search(r"Scheduler: End task `([A-Za-z0-9_-]{1,80})`", line)
        wait = re.search(r"Wait until [0-9 :-]+ for task `([A-Za-z0-9_-]{1,80})`", line)
        if started:
            previous["current"], previous["waiting"] = started.group(1), ""
        elif ended:
            previous["current"] = ""
        elif wait:
            previous["current"], previous["waiting"] = "", wait.group(1)
        elif "exited. Reason:" in line:
            previous["current"], previous["waiting"] = "", ""
    if renderables:
        previous["last"] = renderables[-1]
    return previous["current"], previous["waiting"]


def snapshot(managers, config_dir):
    instances = []
    for name, manager in sorted(list(managers.items()))[:100]:
        if not isinstance(name, str) or not _label.fullmatch(name):
            continue
        state = manager.state
        tasks = []
        file = pathlib.Path(config_dir) / (name + ".json")
        try:
            if file.stat().st_size <= 4 * 1024 * 1024:
                data = json.loads(file.read_text(encoding="utf-8-sig"))
                if not isinstance(data, dict):
                    raise ValueError("Invalid configuration")
                for task in list(data.values())[:500]:
                    if not isinstance(task, dict):
                        continue
                    scheduler = task.get("Scheduler", {})
                    if not isinstance(scheduler, dict):
                        continue
                    command, stamp = scheduler.get("Command", ""), scheduler.get("NextRun", "")
                    if scheduler.get("Enable") is True and isinstance(command, str) and _label.fullmatch(command):
                        try:
                            when = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
                            tasks.append({"name": command, "nextRun": when.astimezone().isoformat()})
                        except (ValueError, TypeError, AttributeError):
                            continue
        except (OSError, ValueError):
            pass
        tasks.sort(key=lambda task: task["nextRun"])
        current, waiting = observe(manager)
        instances.append({
            "name": name,
            "state": {1: "running", 2: "stopped", 3: "error", 4: "updating"}.get(state, "unknown"),
            "currentTask": current if state == 1 else "",
            "waitingTask": waiting if state == 1 else "",
            "tasks": tasks[:20],
        })
    return {"schema": 1, "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "instances": instances}


def read_configuration(secret_file):
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    raw = pathlib.Path(secret_file).read_bytes()
    if not 0 < len(raw) <= 1024 * 1024:
        raise ValueError("Invalid protected configuration")
    buffer = ctypes.create_string_buffer(raw)
    incoming = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    unprotect = ctypes.windll.crypt32.CryptUnprotectData
    unprotect.argtypes = [ctypes.POINTER(Blob), ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    unprotect.restype = wintypes.BOOL
    free = ctypes.windll.kernel32.LocalFree
    free.argtypes, free.restype = [ctypes.c_void_p], ctypes.c_void_p
    if not unprotect(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise OSError("Could not unlock bridge configuration")
    try:
        result = json.loads(ctypes.string_at(outgoing.data, outgoing.size).decode("utf-8"))
        if not isinstance(result.get("secret"), str) or len(result["secret"]) < 32 or not isinstance(result.get("bridgeId"), str):
            raise ValueError("Invalid bridge configuration")
        return result
    finally:
        free(outgoing.data)


def install(secret_file, root):
    import hmac
    import ipaddress
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from module.webui import fastapi

    configuration = read_configuration(secret_file)
    if pathlib.Path(configuration["root"]).resolve() != pathlib.Path(root).resolve():
        raise ValueError("Bridge root does not match configuration")
    bridge_id = configuration["bridgeId"]

    async def status(request):
        try:
            if not request.client or not ipaddress.ip_address(request.client.host).is_loopback:
                return JSONResponse({"error": "loopback only"}, status_code=403)
            active = read_configuration(secret_file)
            if active["bridgeId"] != bridge_id:
                return JSONResponse({"error": "bridge configuration changed"}, status_code=503)
            if not hmac.compare_digest(request.headers.get("Authorization", ""), "Bearer " + active["secret"]):
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            from module.webui.process_manager import ProcessManager
            result = snapshot(ProcessManager._processes, pathlib.Path(root) / "config")
            result["bridgeId"] = bridge_id
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except Exception:
            return JSONResponse({"error": "status unavailable"}, status_code=503)

    original = fastapi.asgi_app

    def patched(*args, **kwargs):
        application = original(*args, **kwargs)
        application.router.routes.insert(0, Route("/panestra/status", status, methods=["GET"]))
        return application

    fastapi.asgi_app = patched


def run_gui(root, secret_file, gui_args, event):
    import os
    import sys
    os.chdir(root)
    if root not in sys.path:
        sys.path.insert(0, root)
    install(secret_file, root)
    import gui
    sys.argv = [str(pathlib.Path(root) / "gui.py")] + gui_args
    gui.func(event)


def main():
    import argparse
    import os
    import sys
    from multiprocessing import Event, Process, freeze_support
    freeze_support()
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--secret-file", required=True)
    args, gui_args = parser.parse_known_args()
    root = pathlib.Path(args.root).resolve(strict=True)
    if not (root / "gui.py").is_file():
        raise SystemExit("ALAS gui.py is missing")
    os.chdir(str(root))
    sys.path.insert(0, str(root))
    from module.webui.setting import State
    if not State.deploy_config.EnableReload:
        run_gui(str(root), args.secret_file, gui_args, None)
        return
    # Preserve ALAS's restart event and automatic task startup in each WebUI child.
    while True:
        event = Event()
        process = Process(target=run_gui, args=(str(root), args.secret_file, gui_args, event))
        process.start()
        try:
            while process.is_alive():
                if event.wait(1):
                    process.kill()
                    break
            process.join()
            if not event.is_set():
                return
        except KeyboardInterrupt:
            if process.is_alive():
                process.terminate()
            process.join()
            return


if __name__ == "__main__":
    main()
