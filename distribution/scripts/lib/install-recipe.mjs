// Installs a Project recipe that the Marketplace only lists, the way the dashboard does before it creates a
// Project from one. A recipe that is already installed is left alone, so this is also right for a release
// that bundled it. Used by the qualification scripts, which start from an actual previous release.
export async function installRecipeIfAvailable({ baseUrl, cookie }, name) {
  const headers = { cookie, origin: baseUrl, "content-type": "application/json", accept: "application/json" };
  const api = `${baseUrl}/zelavis/api/v1/runtime/services`;
  const listed = await fetch(api, { headers });
  if (!listed.ok) throw new Error(`Listing services failed: ${listed.status}`);
  const entry = (await listed.json()).services?.find((service) => service.name === name);
  if (!entry) throw new Error(`${name} is not offered by this installation.`);
  if (entry.status !== "available") return false;
  const result = entry.installVia === "acquire"
    ? await fetch(api, { method: "POST", headers, body: JSON.stringify({ packageSource: `npm:${entry.name}@${entry.version}`, status: "installed" }) })
    : await fetch(`${api}/${encodeURIComponent(name)}`, { method: "PATCH", headers, body: JSON.stringify({ status: "installed" }) });
  if (!result.ok) throw new Error(`Installing ${name} failed: ${result.status} ${(await result.text()).slice(0, 300)}`);
  return true;
}
