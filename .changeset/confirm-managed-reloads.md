---
"zelavis": patch
"@zelavis/wordpress": patch
"@zelavis/dokuwiki": patch
"@zelavis/joomla": patch
"@zelavis/typo3": patch
"@zelavis/prestashop": patch
"@zelavis/drupal": patch
---

During a managed app recipe upgrade, Zelavis holds incoming requests until Caddy confirms that its reload finished. Provisioning and installation also retry transient download failures.
