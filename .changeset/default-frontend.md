---
"zelavis": minor
---

Give every installation a default frontend.

The outermost installation previously returned `404` at `/`, which reads as a
broken installation rather than a working one. It now uses the dashboard as its
default frontend, so `/` leads there — the installation that runs the dashboard
is its own product.

A Project runtime does not run the dashboard and exists to host something that
has not been chosen yet, so it keeps serving the frontend placeholder until a
Frontend is installed. Neither shadows control-plane or API paths, which keep
their own `404`s.
