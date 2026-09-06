---
"zelavis": patch
---

Give nginx every temp path it may create, and prove WordPress provisioning.

The generated nginx config redirected `client_body_temp_path`,
`proxy_temp_path` and `fastcgi_temp_path` into the Project's own directory but
left `uwsgi_temp_path` and `scgi_temp_path` unset. nginx creates a directory for
every module it was built with, whether the config mentions it or not, so on
Debian it fell back to `/var/lib/nginx/uwsgi` and failed its own config test
with a permission error. Homebrew's nginx defaults to a prefix the user owns,
which is why every macOS run passed.

Found by finally running the provisioning path. Every earlier WordPress test had
been on a host that already had nginx, PHP and MariaDB, so the half of the
promise that says an operator installs nothing had never executed. It does now,
in CI and reproducibly on a laptop: from a bare Debian host the driver installs
the packages through apt and brings WordPress up in about twenty seconds,
verified by the site answering WordPress's own redirect to
`wp-admin/install.php` — which it only does once `wp-config.php` exists and the
database is reachable.

The check refuses to run where the packages are already installed, because a
pass there would look like evidence and be none.
