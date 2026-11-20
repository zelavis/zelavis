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
      searchIndex: true,
    }),
  ],
  build: {
    outDir: "dist",
  },
});
