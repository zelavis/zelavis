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
      searchIndex: {
        scopes: [
          "/docs/",
          "/getting-started/",
          "/api/",
          "/architecture/",
          "/packages/",
          "/adapters/",
          "/guides/",
          "/reference/",
          "/cli/",
        ],
      },
      links: {
        ignorePaths: ["/zelavis"],
      },
    }),
  ],
  build: {
    outDir: "dist",
  },
});
