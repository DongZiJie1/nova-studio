# Glass Walkers renderer snapshot

- Source: https://cellmotion.cn/glasswalkers-renderer.js?v=20261103-knee5
- Retrieved: 2026-11-19
- SHA-256: `f39a630ff3594c2dd45b07ec7e14931a8ea7efce215a1fc4fba4db24aadf42e2`
- `glasswalkers-renderer.js` is an unmodified snapshot; its original header is preserved.

Nova calls `GlassWalkersRenderer.draw(canvas, scene, seconds)` directly. GLSL shaders and procedural textures are embedded in this file. It does not fetch scripts, images, fonts, or other resources. The online editor, player, iframe bridge, and export encoders are not runtime dependencies.

The scene configuration is in `src/components/layout/glass-walkers-manifest.json`. `GlassWalkersBackground.tsx` owns animation timing, pause/resume, reduced motion, and WebGL context cleanup. Updating the snapshot requires repeating the offline playback and visual checks and updating this checksum.
