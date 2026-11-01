import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = new URL("..", import.meta.url).pathname;
const stylesPath = join(appRoot, "styles.css");
const sourceExtensions = new Set([".ts", ".tsx"]);
const allowedRawButtonFiles = new Set([
  "components/ui/button.tsx",
  "components/ui/kbd.tsx",
]);
const componentsJsonPath = join(appRoot, "..", "components.json");
const expectedBaseRheaButtonChrome =
  "group/button inline-flex shrink-0 items-center justify-center rounded-2xl border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === ".react-router") {
        return [];
      }

      return collectSourceFiles(path);
    }

    if (!entry.isFile()) {
      return [];
    }

    return sourceExtensions.has(path.slice(path.lastIndexOf("."))) ? [path] : [];
  });
}

describe("button theme usage", () => {
  it("keeps button chrome inside the shared Button variants", () => {
    const rawButtonChrome = /\b(inline-flex|flex)\b(?=[^"`]*\bitems-center\b)(?=[^"`]*\bjustify-center\b)(?=[^"`]*\bfont-medium\b)(?=[^"`]*\bbg-(?:primary|secondary|background|foreground|accent)\b)/;
    const offenders = collectSourceFiles(appRoot).flatMap((file) => {
      const fileName = relative(appRoot, file);

      if (allowedRawButtonFiles.has(fileName)) {
        return [];
      }

      return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .flatMap((line, index) =>
          rawButtonChrome.test(line) ? [`${fileName}:${index + 1}`] : [],
        );
    });

    expect(offenders).toEqual([]);
  });

  it("keeps anchor inheritance in Tailwind base so button utilities win", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const layerIndex = styles.indexOf("@layer base");
    const anchorInheritanceIndex = styles.indexOf("a {\n    color: inherit;");

    expect(layerIndex).toBeGreaterThanOrEqual(0);
    expect(anchorInheritanceIndex).toBeGreaterThan(layerIndex);
  });

  it("keeps shadcn preset application wired through CSS variables", () => {
    const componentsJson = JSON.parse(readFileSync(componentsJsonPath, "utf8"));
    const styles = readFileSync(stylesPath, "utf8");

    expect(componentsJson.style).toBe("base-rhea");
    expect(componentsJson.tailwind.cssVariables).toBe(true);
    expect(componentsJson.tailwind.css).toBe("app/styles.css");
    expect(styles).toContain('@import "shadcn/tailwind.css";');
    expect(styles).toContain("@theme inline");
    expect(styles).toContain("--radius: ");
    expect(styles).toContain("--radius-xl: var(--radius);");
    expect(styles).toContain("--radius-2xl: var(--radius);");
    expect(styles).toContain("--radius-3xl: var(--radius);");
    expect(styles).toContain("--radius-4xl: var(--radius);");
    expect(styles).toContain("--color-primary: var(--primary);");
  });

  it("does not duplicate dark theme token blocks", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const darkThemeBlocks = styles.match(/^\.dark \{/gm) ?? [];

    expect(darkThemeBlocks).toHaveLength(1);
  });

  it("does not force dark mode on shared popup primitives", () => {
    const popupFiles = ["dropdown-menu.tsx", "select.tsx"].map((file) =>
      join(appRoot, "components/ui", file),
    );
    const offenders = popupFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const fileName = relative(appRoot, file);

      return source.split(/\r?\n/).flatMap((line, index) =>
        /\bclassName=\{cn\("dark\b/.test(line)
          ? [`${fileName}:${index + 1}`]
          : [],
      );
    });

    expect(offenders).toEqual([]);
  });

  it("keeps text buttons on the shared default size", () => {
    const sizedTextButton =
      /<Button\b(?:(?!>).)*\bsize="(?:xs|sm|lg)"|buttonVariants\(\{[^}]*\bsize: "(?:xs|sm|lg)"/gs;
    const offenders = collectSourceFiles(appRoot).flatMap((file) => {
      const fileName = relative(appRoot, file);

      if (allowedRawButtonFiles.has(fileName)) {
        return [];
      }

      const source = readFileSync(file, "utf8");

      return [...source.matchAll(sizedTextButton)].map((match) => {
        const line = source.slice(0, match.index).split(/\r?\n/).length;

        return `${fileName}:${line}`;
      });
    });

    expect(offenders).toEqual([]);
  });

  it("keeps Button aligned with the current base-rhea generated defaults", () => {
    const buttonSource = readFileSync(join(appRoot, "components/ui/button.tsx"), "utf8");

    expect(buttonSource).toContain(expectedBaseRheaButtonChrome);
    expect(buttonSource).toContain(
      '"border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:bg-transparent dark:hover:bg-input/30"',
    );
    expect(buttonSource).toContain(
      '"h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5"',
    );
  });
});
