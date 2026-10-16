// vite.config.mjs
import { defineConfig } from "file:///D:/test-project/xiaoshuoyueduqi/novel-reader/node_modules/vite/dist/node/index.js";
import vue from "file:///D:/test-project/xiaoshuoyueduqi/novel-reader/node_modules/@vitejs/plugin-vue/dist/index.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module from "node:module";
import { createRequire } from "node:module";
var __vite_injected_original_import_meta_url = "file:///D:/test-project/xiaoshuoyueduqi/novel-reader/vite.config.mjs";
var __dirname = path.dirname(fileURLToPath(__vite_injected_original_import_meta_url));
var origLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "vscode") {
    return { workspace: { getConfiguration: () => ({ get: () => void 0, has: () => false }) } };
  }
  return origLoad.call(this, request, parent, isMain);
};
var require2 = createRequire(__vite_injected_original_import_meta_url);
var settings = require2(path.join(__dirname, "dist", "settings.js"));
var fontStacks = Object.fromEntries(settings.FONTS.map((f) => [f.id, f.stack]));
var virtualConstants = {
  name: "novel-constants",
  resolveId(id) {
    if (id === "virtual:novel-constants") {
      return "\0virtual:novel-constants";
    }
    return null;
  },
  load(id) {
    if (id !== "\0virtual:novel-constants") {
      return null;
    }
    return [
      "export const THEMES = " + JSON.stringify(settings.THEMES) + ";",
      "export const FONT_STACKS = " + JSON.stringify(fontStacks) + ";",
      "export const DEFAULT_SETTINGS = " + JSON.stringify(settings.DEFAULT_SETTINGS) + ";"
    ].join("\n");
  }
};
var vite_config_default = defineConfig(function({ command }) {
  const isServe = command === "serve";
  const name = "reader";
  return {
    plugins: [vue(), virtualConstants],
    server: {
      port: 5199,
      strictPort: false
    },
    define: {
      // 构建产物在 webview(无 Node 环境)里运行, 固定 production;
      // dev server 下保留 development(否则 Vue 会以生产模式运行, 无 HMR 友好提示)
      ...isServe ? {} : { "process.env.NODE_ENV": JSON.stringify("production") }
    },
    build: {
      outDir: "dist-webview",
      emptyOutDir: true,
      target: "es2020",
      lib: {
        entry: path.join(__dirname, "webview", "reader", "main.ts"),
        name: "NovelReaderPanel",
        formats: ["iife"],
        fileName: () => name + ".js"
      },
      rollupOptions: {
        output: {
          assetFileNames: function(info) {
            return info.names && info.names[0] && info.names[0].endsWith(".css") ? name + ".css" : "[name][extname]";
          }
        }
      }
    }
  };
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcubWpzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiRDpcXFxcdGVzdC1wcm9qZWN0XFxcXHhpYW9zaHVveXVlZHVxaVxcXFxub3ZlbC1yZWFkZXJcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIkQ6XFxcXHRlc3QtcHJvamVjdFxcXFx4aWFvc2h1b3l1ZWR1cWlcXFxcbm92ZWwtcmVhZGVyXFxcXHZpdGUuY29uZmlnLm1qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vRDovdGVzdC1wcm9qZWN0L3hpYW9zaHVveXVlZHVxaS9ub3ZlbC1yZWFkZXIvdml0ZS5jb25maWcubWpzXCI7LyoqXG4gKiB2aXRlLmNvbmZpZy5tanMgXHUyMDE0IFx1NjI1M1x1NTMwNSB3ZWJ2aWV3IChWdWUgMyAtPiBJSUZFIFx1NTM1NVx1NjU4N1x1NEVGNilcbiAqICAtIFx1OUVEOFx1OEJBNFx1Njc4NFx1NUVGQVx1OTYwNVx1OEJGQlx1OTc2Mlx1Njc3RjogZGlzdC13ZWJ2aWV3L3JlYWRlci5qcyArIHJlYWRlci5jc3NcbiAqICAtIGAtLW1vZGUgc2lkZWJhcmAgXHU2Nzg0XHU1RUZBXHU0RkE3XHU4RkI5XHU2ODBGOiBkaXN0LXdlYnZpZXcvc2lkZWJhci5qcyArIHNpZGViYXIuY3NzXG4gKiAgXHU0RUE3XHU3MjY5XHU3NTMxIHJlYWRlclBhbmVsLnRzIC8gY2hhcHRlclZpZXdQcm92aWRlci50cyBcdTUxODVcdTgwNTRcdThGREIgd2VidmlldyBIVE1MXG4gKi9cbmltcG9ydCB7IGRlZmluZUNvbmZpZyB9IGZyb20gJ3ZpdGUnO1xuaW1wb3J0IHZ1ZSBmcm9tICdAdml0ZWpzL3BsdWdpbi12dWUnO1xuaW1wb3J0IHBhdGggZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tICdub2RlOnVybCc7XG5pbXBvcnQgTW9kdWxlIGZyb20gJ25vZGU6bW9kdWxlJztcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tICdub2RlOm1vZHVsZSc7XG5cbmNvbnN0IF9fZGlybmFtZSA9IHBhdGguZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuXG4vLyBkaXN0L3NldHRpbmdzLmpzIFx1OTg3Nlx1NUM0MiByZXF1aXJlKCd2c2NvZGUnKSwgXHU2Nzg0XHU1RUZBXHU2NUY2XHU3RUQ5XHU0RTJBXHU3QTdBXHU2ODY5XG5jb25zdCBvcmlnTG9hZCA9IE1vZHVsZS5fbG9hZDtcbk1vZHVsZS5fbG9hZCA9IGZ1bmN0aW9uIChyZXF1ZXN0LCBwYXJlbnQsIGlzTWFpbikge1xuICBpZiAocmVxdWVzdCA9PT0gJ3ZzY29kZScpIHtcbiAgICByZXR1cm4geyB3b3Jrc3BhY2U6IHsgZ2V0Q29uZmlndXJhdGlvbjogKCkgPT4gKHsgZ2V0OiAoKSA9PiB1bmRlZmluZWQsIGhhczogKCkgPT4gZmFsc2UgfSkgfSB9O1xuICB9XG4gIHJldHVybiBvcmlnTG9hZC5jYWxsKHRoaXMsIHJlcXVlc3QsIHBhcmVudCwgaXNNYWluKTtcbn07XG5jb25zdCByZXF1aXJlMiA9IGNyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcbmNvbnN0IHNldHRpbmdzID0gcmVxdWlyZTIocGF0aC5qb2luKF9fZGlybmFtZSwgJ2Rpc3QnLCAnc2V0dGluZ3MuanMnKSk7XG5jb25zdCBmb250U3RhY2tzID0gT2JqZWN0LmZyb21FbnRyaWVzKHNldHRpbmdzLkZPTlRTLm1hcCgoZikgPT4gW2YuaWQsIGYuc3RhY2tdKSk7XG5cbi8qKlxuICogXHU4NjVBXHU2MkRGXHU2QTIxXHU1NzU3ICd2aXJ0dWFsOm5vdmVsLWNvbnN0YW50cycgXHUyMDE0IFx1NjI4QSBzZXR0aW5ncy50cyBcdTc2ODRcdTVFMzhcdTkxQ0ZcdTZDRThcdTUxNjUgd2Vidmlld1x1MzAwMlxuICogXHU3NTI4XHU4NjVBXHU2MkRGXHU2QTIxXHU1NzU3XHU4MDBDXHU5NzVFIHZpdGUgZGVmaW5lOiBkZWZpbmUgXHU1NzI4IGRldihlc2J1aWxkIFx1OERFRlx1NUY4NCkgXHU0RTBCXHU0RTBEXHU1M0VGXHU5NzYwLCBcdTg2NUFcdTYyREZcdTZBMjFcdTU3NTcgZGV2L2J1aWxkIFx1ODg0Q1x1NEUzQVx1NEUwMFx1ODFGNFx1MzAwMlxuICovXG5jb25zdCB2aXJ0dWFsQ29uc3RhbnRzID0ge1xuICBuYW1lOiAnbm92ZWwtY29uc3RhbnRzJyxcbiAgcmVzb2x2ZUlkKGlkKSB7XG4gICAgaWYgKGlkID09PSAndmlydHVhbDpub3ZlbC1jb25zdGFudHMnKSB7IHJldHVybiAnXFwwdmlydHVhbDpub3ZlbC1jb25zdGFudHMnOyB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH0sXG4gIGxvYWQoaWQpIHtcbiAgICBpZiAoaWQgIT09ICdcXDB2aXJ0dWFsOm5vdmVsLWNvbnN0YW50cycpIHsgcmV0dXJuIG51bGw7IH1cbiAgICByZXR1cm4gW1xuICAgICAgJ2V4cG9ydCBjb25zdCBUSEVNRVMgPSAnICsgSlNPTi5zdHJpbmdpZnkoc2V0dGluZ3MuVEhFTUVTKSArICc7JyxcbiAgICAgICdleHBvcnQgY29uc3QgRk9OVF9TVEFDS1MgPSAnICsgSlNPTi5zdHJpbmdpZnkoZm9udFN0YWNrcykgKyAnOycsXG4gICAgICAnZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VUVElOR1MgPSAnICsgSlNPTi5zdHJpbmdpZnkoc2V0dGluZ3MuREVGQVVMVF9TRVRUSU5HUykgKyAnOycsXG4gICAgXS5qb2luKCdcXG4nKTtcbiAgfSxcbn07XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyhmdW5jdGlvbiAoeyBjb21tYW5kIH0pIHtcbiAgY29uc3QgaXNTZXJ2ZSA9IGNvbW1hbmQgPT09ICdzZXJ2ZSc7XG4gIGNvbnN0IG5hbWUgPSAncmVhZGVyJztcbiAgcmV0dXJuIHtcbiAgICBwbHVnaW5zOiBbdnVlKCksIHZpcnR1YWxDb25zdGFudHNdLFxuICAgIHNlcnZlcjoge1xuICAgICAgcG9ydDogNTE5OSxcbiAgICAgIHN0cmljdFBvcnQ6IGZhbHNlLFxuICAgIH0sXG4gICAgZGVmaW5lOiB7XG4gICAgICAvLyBcdTY3ODRcdTVFRkFcdTRFQTdcdTcyNjlcdTU3Mjggd2VidmlldyhcdTY1RTAgTm9kZSBcdTczQUZcdTU4ODMpXHU5MUNDXHU4RkQwXHU4ODRDLCBcdTU2RkFcdTVCOUEgcHJvZHVjdGlvbjtcbiAgICAgIC8vIGRldiBzZXJ2ZXIgXHU0RTBCXHU0RkREXHU3NTU5IGRldmVsb3BtZW50KFx1NTQyNlx1NTIxOSBWdWUgXHU0RjFBXHU0RUU1XHU3NTFGXHU0RUE3XHU2QTIxXHU1RjBGXHU4RkQwXHU4ODRDLCBcdTY1RTAgSE1SIFx1NTNDQlx1NTk3RFx1NjNEMFx1NzkzQSlcbiAgICAgIC4uLihpc1NlcnZlID8ge30gOiB7ICdwcm9jZXNzLmVudi5OT0RFX0VOVic6IEpTT04uc3RyaW5naWZ5KCdwcm9kdWN0aW9uJykgfSksXG4gICAgfSxcbiAgICBidWlsZDoge1xuICAgICAgb3V0RGlyOiAnZGlzdC13ZWJ2aWV3JyxcbiAgICAgIGVtcHR5T3V0RGlyOiB0cnVlLFxuICAgICAgdGFyZ2V0OiAnZXMyMDIwJyxcbiAgICAgIGxpYjoge1xuICAgICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJ3dlYnZpZXcnLCAncmVhZGVyJywgJ21haW4udHMnKSxcbiAgICAgICAgbmFtZTogJ05vdmVsUmVhZGVyUGFuZWwnLFxuICAgICAgICBmb3JtYXRzOiBbJ2lpZmUnXSxcbiAgICAgICAgZmlsZU5hbWU6ICgpID0+IG5hbWUgKyAnLmpzJyxcbiAgICAgIH0sXG4gICAgICByb2xsdXBPcHRpb25zOiB7XG4gICAgICAgIG91dHB1dDoge1xuICAgICAgICAgIGFzc2V0RmlsZU5hbWVzOiBmdW5jdGlvbiAoaW5mbykge1xuICAgICAgICAgICAgcmV0dXJuIGluZm8ubmFtZXMgJiYgaW5mby5uYW1lc1swXSAmJiBpbmZvLm5hbWVzWzBdLmVuZHNXaXRoKCcuY3NzJylcbiAgICAgICAgICAgICAgPyBuYW1lICsgJy5jc3MnXG4gICAgICAgICAgICAgIDogJ1tuYW1lXVtleHRuYW1lXSc7XG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQU1BLFNBQVMsb0JBQW9CO0FBQzdCLE9BQU8sU0FBUztBQUNoQixPQUFPLFVBQVU7QUFDakIsU0FBUyxxQkFBcUI7QUFDOUIsT0FBTyxZQUFZO0FBQ25CLFNBQVMscUJBQXFCO0FBWDBLLElBQU0sMkNBQTJDO0FBYXpQLElBQU0sWUFBWSxLQUFLLFFBQVEsY0FBYyx3Q0FBZSxDQUFDO0FBRzdELElBQU0sV0FBVyxPQUFPO0FBQ3hCLE9BQU8sUUFBUSxTQUFVLFNBQVMsUUFBUSxRQUFRO0FBQ2hELE1BQUksWUFBWSxVQUFVO0FBQ3hCLFdBQU8sRUFBRSxXQUFXLEVBQUUsa0JBQWtCLE9BQU8sRUFBRSxLQUFLLE1BQU0sUUFBVyxLQUFLLE1BQU0sTUFBTSxHQUFHLEVBQUU7QUFBQSxFQUMvRjtBQUNBLFNBQU8sU0FBUyxLQUFLLE1BQU0sU0FBUyxRQUFRLE1BQU07QUFDcEQ7QUFDQSxJQUFNLFdBQVcsY0FBYyx3Q0FBZTtBQUM5QyxJQUFNLFdBQVcsU0FBUyxLQUFLLEtBQUssV0FBVyxRQUFRLGFBQWEsQ0FBQztBQUNyRSxJQUFNLGFBQWEsT0FBTyxZQUFZLFNBQVMsTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxDQUFDO0FBTWhGLElBQU0sbUJBQW1CO0FBQUEsRUFDdkIsTUFBTTtBQUFBLEVBQ04sVUFBVSxJQUFJO0FBQ1osUUFBSSxPQUFPLDJCQUEyQjtBQUFFLGFBQU87QUFBQSxJQUE2QjtBQUM1RSxXQUFPO0FBQUEsRUFDVDtBQUFBLEVBQ0EsS0FBSyxJQUFJO0FBQ1AsUUFBSSxPQUFPLDZCQUE2QjtBQUFFLGFBQU87QUFBQSxJQUFNO0FBQ3ZELFdBQU87QUFBQSxNQUNMLDJCQUEyQixLQUFLLFVBQVUsU0FBUyxNQUFNLElBQUk7QUFBQSxNQUM3RCxnQ0FBZ0MsS0FBSyxVQUFVLFVBQVUsSUFBSTtBQUFBLE1BQzdELHFDQUFxQyxLQUFLLFVBQVUsU0FBUyxnQkFBZ0IsSUFBSTtBQUFBLElBQ25GLEVBQUUsS0FBSyxJQUFJO0FBQUEsRUFDYjtBQUNGO0FBRUEsSUFBTyxzQkFBUSxhQUFhLFNBQVUsRUFBRSxRQUFRLEdBQUc7QUFDakQsUUFBTSxVQUFVLFlBQVk7QUFDNUIsUUFBTSxPQUFPO0FBQ2IsU0FBTztBQUFBLElBQ0wsU0FBUyxDQUFDLElBQUksR0FBRyxnQkFBZ0I7QUFBQSxJQUNqQyxRQUFRO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixZQUFZO0FBQUEsSUFDZDtBQUFBLElBQ0EsUUFBUTtBQUFBO0FBQUE7QUFBQSxNQUdOLEdBQUksVUFBVSxDQUFDLElBQUksRUFBRSx3QkFBd0IsS0FBSyxVQUFVLFlBQVksRUFBRTtBQUFBLElBQzVFO0FBQUEsSUFDQSxPQUFPO0FBQUEsTUFDTCxRQUFRO0FBQUEsTUFDUixhQUFhO0FBQUEsTUFDYixRQUFRO0FBQUEsTUFDUixLQUFLO0FBQUEsUUFDSCxPQUFPLEtBQUssS0FBSyxXQUFXLFdBQVcsVUFBVSxTQUFTO0FBQUEsUUFDMUQsTUFBTTtBQUFBLFFBQ04sU0FBUyxDQUFDLE1BQU07QUFBQSxRQUNoQixVQUFVLE1BQU0sT0FBTztBQUFBLE1BQ3pCO0FBQUEsTUFDQSxlQUFlO0FBQUEsUUFDYixRQUFRO0FBQUEsVUFDTixnQkFBZ0IsU0FBVSxNQUFNO0FBQzlCLG1CQUFPLEtBQUssU0FBUyxLQUFLLE1BQU0sQ0FBQyxLQUFLLEtBQUssTUFBTSxDQUFDLEVBQUUsU0FBUyxNQUFNLElBQy9ELE9BQU8sU0FDUDtBQUFBLFVBQ047QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
