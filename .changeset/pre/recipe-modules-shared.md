---
"zelavis": patch
---

Deleting a third-party app Project (WordPress, DokuWiki, Drupal, Joomla, TYPO3, PrestaShop) no longer breaks the next Project created from the same recipe with "The recipe package has no readable package.json." Projects of one recipe version share its runtime, which now runs from a copy kept beside the Projects instead of inside the first one; copies no Project uses are removed when the Platform starts.
