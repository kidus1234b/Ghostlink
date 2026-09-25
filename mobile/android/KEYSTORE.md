# GhostLink release signing

## The keystore

`android/app/ghostlink-release.keystore` signs every release APK. It was created with:

```bash
keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore ghostlink-release.keystore \
  -alias ghostlink \
  -keyalg RSA -keysize 4096 -validity 10950 \
  -storepass "<PASSWORD>" -keypass "<PASSWORD>" \
  -dname "CN=GhostLink, OU=GhostLink, O=GhostLink, L=Unknown, ST=Unknown, C=US"
```

- Type: PKCS12, RSA 4096, SHA384withRSA
- Alias: `ghostlink`
- Validity: 10950 days (30 years, expires 2056-09-02)

The password is in `android/keystore.properties`, which the Gradle build reads at
configure time. Neither file is in version control.

## Back this up — now

**Losing the keystore or its password means you can never update GhostLink again.**
Android identifies an app by its signing key. An APK signed with a different key is
a different app to the operating system: it cannot upgrade an installed GhostLink,
and Play Store will reject it outright. There is no recovery, no reset, and no
appeal. Every existing install would have to uninstall first, losing local data.

Back up **both** of these, together, somewhere offline:

1. `android/app/ghostlink-release.keystore`
2. `android/keystore.properties` (contains the password)

Keep at least two copies in different physical locations. Treat them like the
12-word recovery phrase — because they are exactly as unrecoverable.

## Verifying a build's signature

```bash
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
```

The certificate must read `CN=GhostLink` with SHA-256
`80:34:69:C2:35:EA:F9:5F:19:70:C2:4C:08:7A:AA:DE:B4:34:1C:57:1F:D8:2B:9F:16:ED:C8:51:9A:A3:64:D5`.
A release build no longer falls back to the debug key: if `keystore.properties`
is missing, incomplete, or points at a keystore that does not exist, every
release task fails with "Release build refused". If you ever see
`CN=Android Debug` on a release APK, do not distribute it.
