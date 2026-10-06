import installer from "../../../distribution/installers/install.sh?raw";

export const prerender = true;
export function GET() {
  return new Response(installer, {
    headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
  });
}
