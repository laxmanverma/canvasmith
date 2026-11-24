# Vendored: polygon-clipping

`polygon-clipping.mjs` is a single-file ES-module bundle of:

| package | version | licence |
|---|---|---|
| [polygon-clipping](https://github.com/mfogel/polygon-clipping) | 0.15.7 | MIT (`LICENSE.polygon-clipping`) |
| [splaytree](https://github.com/w8r/splay-tree) | 3.2.4 | MIT (`LICENSE.splaytree`) |
| [robust-predicates](https://github.com/mourner/robust-predicates) | 3.0.3 | Unlicense (`LICENSE.robust-predicates`) |

It is vendored (not an npm dependency) because the demo loads `@canvasmith/core` as native ES modules with no bundler,
so a bare `import 'polygon-clipping'` would not resolve. Used by `../../src/booleans.js` for Union / Subtract / Intersect /
Exclude (default export: `{ union, difference, intersection, xor }` over MultiPolygons).

Rebuild:

```sh
mkdir build && cd build && npm init -y && npm i polygon-clipping@0.15.7
printf "import pc from 'polygon-clipping';\nexport default pc;\n" > entry.mjs
npx esbuild@0.24.2 entry.mjs --bundle --format=esm --minify --outfile=polygon-clipping.mjs
```
