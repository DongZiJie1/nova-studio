import { memo } from "react";
import { useUiStore } from "../../stores/ui-store";

export const Background = memo(function Background() {
  const customBgUrl = useUiStore((s) => s.customBgUrl);
  const backgroundBlur = useUiStore((s) => s.backgroundBlur);
  const theme = useUiStore((s) => s.theme);
  const isDawn = theme === "arctic-dawn";

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Deep space base */}
      <div
        className="absolute inset-0 theme-background-base"
        style={{
          background: isDawn
            ? "linear-gradient(180deg, #f9fbff 0%, #eef5ff 52%, #dce9fb 100%)"
            : "#04050c",
        }}
      />

      {/* Faint violet atmosphere at the top */}
      <div
        className="absolute inset-0"
        style={{
          background: isDawn
            ? "radial-gradient(ellipse 82% 42% at 50% -8%, rgba(255,255,255,0.36) 0%, rgba(220,234,252,0.12) 52%, transparent 76%)"
            : "radial-gradient(ellipse 70% 45% at 50% -5%, rgba(74, 66, 150, 0.16) 0%, transparent 70%)",
        }}
      />

      {/* Light rising from the horizon's midpoint — spreads wider than the
          screen and fades gradually, so no ellipse edge is ever visible.
          It backlights the hero text above the arc. */}
      <div
        className="absolute inset-0"
        style={{
          background: isDawn
            ? "transparent"
            : "radial-gradient(ellipse 135% 46% at 50% 66%, rgba(128, 138, 252, 0.15) 0%, rgba(102, 110, 235, 0.08) 35%, rgba(70, 74, 180, 0.03) 55%, transparent 72%)",
        }}
      />

      {/* Planet body — very wide, very tall ellipse; only its top rim shows.
          Sized in vw so the horizon curvature stays stable when the window
          is resized; the apex sits at ~58% of the viewport height. */}
      <div
        className="absolute left-1/2"
        style={{
          display: isDawn && customBgUrl ? "none" : undefined,
          top: "58%",
          transform: "translate(-50%, 0)",
          width: "260vw",
          height: "412vw",
          borderRadius: "50%",
          background: isDawn
            ? "radial-gradient(ellipse 55% 1.8% at 50% 0.4%, rgba(255,255,255,0.9) 0%, transparent 70%), radial-gradient(ellipse at 50% 0%, #e7f1ff 0%, #d8e7fa 45%, #c7daf2 100%)"
            : "radial-gradient(ellipse 55% 1.8% at 50% 0.4%, rgba(126, 136, 255, 0.1) 0%, transparent 70%), radial-gradient(ellipse at 50% 0%, #070913 0%, #04050c 45%, #020308 100%)",
        }}
      />

      {/* Horizon line — bright rim with layered glow, brightest at center fading to edges */}
      <div
        className="absolute left-1/2"
        style={{
          display: isDawn && customBgUrl ? "none" : undefined,
          top: "58%",
          transform: "translate(-50%, 0)",
          width: "260vw",
          height: "412vw",
          borderRadius: "50%",
          border: isDawn ? "1.5px solid rgba(255,255,255,0.95)" : "1.5px solid rgba(168, 178, 255, 0.5)",
          boxShadow: (isDawn ? [
            "0 0 26px 3px rgba(255,255,255,0.95)",
            "0 0 100px 24px rgba(115,171,238,0.24)",
            "0 0 220px 68px rgba(102,155,220,0.12)",
            "inset 0 2px 44px rgba(255,255,255,0.42)",
          ] : [
            "0 0 24px 2px rgba(150, 160, 255, 0.35)",
            "0 0 90px 18px rgba(120, 130, 250, 0.16)",
            "0 0 220px 60px rgba(105, 96, 240, 0.07)",
            "inset 0 2px 44px rgba(140, 150, 255, 0.1)",
          ]).join(", "),
          background: "transparent",
          WebkitMaskImage:
            "linear-gradient(90deg, rgba(0,0,0,0.15) 10%, rgba(0,0,0,0.4) 25%, rgba(0,0,0,0.7) 38%, black 50%, rgba(0,0,0,0.7) 62%, rgba(0,0,0,0.4) 75%, rgba(0,0,0,0.15) 90%)",
          maskImage:
            "linear-gradient(90deg, rgba(0,0,0,0.15) 10%, rgba(0,0,0,0.4) 25%, rgba(0,0,0,0.7) 38%, black 50%, rgba(0,0,0,0.7) 62%, rgba(0,0,0,0.4) 75%, rgba(0,0,0,0.15) 90%)",
        }}
      />

      {/* Center bloom — the arc burns brightest at its midpoint, fading to left/right */}
      <div
        className="absolute inset-0"
        style={{
          background: isDawn
            ? "transparent"
            : "radial-gradient(ellipse 60% 7% at 50% 58%, rgba(195, 202, 255, 0.3) 0%, rgba(140, 150, 255, 0.12) 30%, transparent 55%)",
        }}
      />

      {/* Wide faint halo hugging the horizon — brightest at center */}
      <div
        className="absolute inset-0"
        style={{
          background: isDawn
            ? "transparent"
            : "radial-gradient(ellipse 80% 13% at 50% 60%, rgba(110, 118, 240, 0.06) 0%, transparent 60%)",
        }}
      />

      {/* Custom background image */}
      {customBgUrl && (
        <>
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${customBgUrl})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              transform: `scale(${1.008 + backgroundBlur * 0.001})`,
              filter: `blur(${backgroundBlur}px) saturate(1.02)`,
            }}
          />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${customBgUrl})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              transform: `scale(${1.004 + backgroundBlur * 0.001})`,
              filter: `blur(${backgroundBlur * 0.35}px) saturate(1.04)`,
              WebkitMaskImage:
                "radial-gradient(ellipse 58% 52% at 50% 48%, black 0%, rgba(0,0,0,0.98) 38%, rgba(0,0,0,0.72) 56%, rgba(0,0,0,0.24) 74%, transparent 92%)",
              maskImage:
                "radial-gradient(ellipse 58% 52% at 50% 48%, black 0%, rgba(0,0,0,0.98) 38%, rgba(0,0,0,0.72) 56%, rgba(0,0,0,0.24) 74%, transparent 92%)",
            }}
          />
          <div
            className="absolute inset-0"
            style={{
              background: "linear-gradient(180deg, rgba(8,12,20,0.46), rgba(8,12,20,0.52))",
            }}
          />
        </>
      )}
    </div>
  );
});
