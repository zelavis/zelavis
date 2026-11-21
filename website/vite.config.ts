import { defineConfig } from "vite";
import { fuzorPlugin } from "fuzor/vite";

export default defineConfig({
  plugins: [
    fuzorPlugin({
      markdown: {
        highlight: {
          theme: "github-dark",
        },
      },
      // `/zelavis/` is the Platform dashboard (login included), served outside this site.
      links: { ignorePaths: ["/zelavis/"] },
      searchIndex: true,
    }),
  ],
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
