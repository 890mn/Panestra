// Pin the generated Android template to the installed stable SDK/toolchain.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../shell/desktop/gen/android');
await copyFile(
  path.resolve(import.meta.dirname, '../shell/android/MainActivity.kt'),
  path.join(root, 'app/src/main/java/dev/panestra/app/MainActivity.kt'),
);
await update('app/src/main/res/values/strings.xml', (text) =>
  text.replace(/(<string name="app_name">)[^<]*(<\/string>)/, '$1星序$2'),
);
async function update(file, fn) {
  const target = path.join(root, file);
  await writeFile(target, fn(await readFile(target, 'utf8')));
}
await update('build.gradle.kts', (text) =>
  text.replace(/com\.android\.tools\.build:gradle:[\d.]+/, 'com.android.tools.build:gradle:8.9.2'),
);
await update('buildSrc/build.gradle.kts', (text) =>
  text.replace(/com\.android\.tools\.build:gradle:[\d.]+/, 'com.android.tools.build:gradle:8.9.2'),
);
await update('gradle/wrapper/gradle-wrapper.properties', (text) =>
  text.replace(/gradle-[\d.]+-bin\.zip/, 'gradle-8.11.1-bin.zip'),
);
await update('app/build.gradle.kts', (text) =>
  text
    .replace(
      '    buildTypes {',
      text.includes('Optional publisher signing')
        ? '    buildTypes {'
        : `
    // Optional publisher signing configuration, injected from environment only.
    signingConfigs {
        if (System.getenv("PANESTRA_ANDROID_KEYSTORE") != null) {
            create("panestraRelease") {
                storeFile = file(System.getenv("PANESTRA_ANDROID_KEYSTORE"))
                storePassword = System.getenv("PANESTRA_ANDROID_STORE_PASSWORD")
                keyAlias = System.getenv("PANESTRA_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("PANESTRA_ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {`,
    )
    .replace(
      '        getByName("release") {',
      text.includes('signingConfig = signingConfigs')
        ? '        getByName("release") {'
        : `        getByName("release") {
            if (signingConfigs.findByName("panestraRelease") != null) {
                signingConfig = signingConfigs.getByName("panestraRelease")
            }`,
    )
    .replace(/compileSdk = \d+/, 'compileSdk = 36')
    .replace(/targetSdk = \d+/, 'targetSdk = 36')
    .replace(/minSdk = \d+/, 'minSdk = 29')
    .replace(/optimization\s*\{\s*enable = true\s*\}/, 'isMinifyEnabled = true')
    .replace(
      /manifestPlaceholders\["usesCleartextTraffic"\] = "true"/g,
      'manifestPlaceholders["usesCleartextTraffic"] = "false"',
    )
    .replace(/isJniDebuggable = true/g, 'isJniDebuggable = false')
    .replace(/^\s*jniLibs\.keepDebugSymbols\.add\([^\n]*\)\r?\n/gm, ''),
);
await update('gradle.properties', (text) =>
  text.includes('android.useAndroidX=')
    ? text.replace(/android.useAndroidX=.*/, 'android.useAndroidX=true')
    : text + '\nandroid.useAndroidX=true\n',
);
console.log('Android: SDK 36, minSdk 29, AGP 8.9.2, Gradle 8.11.1, cleartext disabled');
