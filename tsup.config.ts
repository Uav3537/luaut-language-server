import { defineConfig } from "tsup";

export default defineConfig({
    // `index` is the library face; `cli` is the binary editors launch.
    entry: ["src/index.ts", "src/cli.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node18",
    platform: "node",
    shims: true,
});
