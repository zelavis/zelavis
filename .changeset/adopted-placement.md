---
"zelavis": patch
---

A recipe update that replaces an app's processes, such as DokuWiki moving to the new `app/` layout, now works after the Platform has been updated. After **Update now**, the Platform takes over running apps without the placement it had handed out, so a replacement process was refused by the Agent ("A process could not be started") and the update needed recovery. The Platform now hands the current placement to every process it starts, including for apps it took over. A failed update of this kind is recovered when the Platform next starts, including through **Update now**.
