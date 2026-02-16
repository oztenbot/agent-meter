import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "middleware/express": "src/middleware/express.ts",
    "transport/sqlite": "src/transport/sqlite.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  clean: true,
  target: "node18",
});
