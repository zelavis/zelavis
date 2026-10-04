/** A fresh Platform must offer the recipe versions qualified with this release. */
export function assertReleaseAllowlist(snapshot, manifests) {
  for (const manifest of manifests) {
    const service = snapshot.services.find((entry) => entry.name === manifest.name);
    if (service?.latest !== manifest.version || !service.versions.some((entry) => entry.version === manifest.version)) {
      throw new Error(`${manifest.name}@${manifest.version} is not the shipped allow-list default. Publish changed services first, run pnpm allowlist update, then build and publish the Platform.`);
    }
  }
}
