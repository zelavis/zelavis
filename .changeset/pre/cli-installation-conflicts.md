---
"zelavis": patch
---

Stop one installation of Zelavis silently replacing or shadowing another, and
report which one is running.

The command name is shared by installs that cannot see each other. A Debian
package links `/usr/bin/zelavis`, the archive installer links
`/usr/local/bin/zelavis`, and `npm install --global zelavis` writes into npm's
prefix, which is commonly that same `/usr/local/bin`. Two failures followed.
The archive installer's `ln -sfn` replaced an npm install without a word. And
because `/usr/local/bin` precedes `/usr/bin` on Debian and Ubuntu, an npm
install shadows a packaged one with nothing overwritten: both are present,
both look healthy, and `zelavis` quietly means the npm copy.

The archive installer now refuses to replace a `zelavis` it did not create,
naming what the path resolves to and how to proceed — remove the other
install, set `ZELAVIS_BIN_DIR` elsewhere, or set `ZELAVIS_FORCE_BIN=1` to
replace it deliberately. Its own link from an earlier release is still
replaced, so upgrades are unaffected.

Shadowing cannot be refused, because nothing is overwritten: path order alone
decides. Both the archive installer and the Debian package's `postinst` now
warn when `zelavis` on the path resolves somewhere other than the copy just
installed. The Debian package warns rather than failing, because refusing an
install over path order would break `apt upgrade`.

`zelavis --version` now also prints the installation it is running from —
packaged, npm, or a source checkout — resolved through symlinks. The version
alone cannot distinguish two installs that may hold the same version, so this
is what turns "the upgrade did not take effect" into a question that answers
itself. The bare version stays on the first line.
