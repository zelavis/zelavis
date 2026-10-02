---
"zelavis": minor
"create-zelavis": minor
---

A server install ends with a URL you can open. The default instance of a systemd installation now listens on all interfaces at port 3000 instead of loopback, and the installer prints `http://<server-ip>:3000/zelavis` with the first-owner token, so there is no SSH tunnel to set up. The token still decides who may claim the owner account, the address is plain HTTP until the setup wizard's hostname step adds HTTPS, and there is no loopback-only server mode. User-mode installs and named instances stay on `127.0.0.1` unless given `--public`. Re-running the installer applies the new bind.
