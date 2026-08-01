import { useUiStore } from "../../stores/ui-store";

export function Background() {
  const customBgUrl = useUiStore((s) => s.customBgUrl);

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Deep space base */}
      <div className="absolute inset-0" style={{ background: "#04050c" }} />

      {/* Faint violet atmosphere at the top */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 45% at 50% -5%, rgba(74, 66, 150, 0.16) 0%, transparent 70%)",
        }}
      />

      {/* Light rising from the horizon's midpoint — spreads wider than the
          screen and fades gradually, so no ellipse edge is ever visible.
          It backlights the hero text above the arc. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 135% 46% at 50% 60%, rgba(128, 138, 252, 0.15) 0%, rgba(102, 110, 235, 0.08) 35%, rgba(70, 74, 180, 0.03) 55%, transparent 72%)",
        }}
      />

      {/* Planet body — very wide, very tall ellipse; only its top rim shows.
          Sized in vw so the horizon curvature stays stable when the window
          is resized; the apex sits at ~52% of the viewport height. */}
      <div
        className="absolute left-1/2"
        style={{
          top: "52%",
          transform: "translate(-50%, 0)",
          width: "260vw",
          height: "412vw",
          borderRadius: "50%",
          background:
            "radial-gradient(ellipse 55% 1.8% at 50% 0.4%, rgba(126, 136, 255, 0.1) 0%, transparent 70%), radial-gradient(ellipse at 50% 0%, #070913 0%, #04050c 45%, #020308 100%)",
        }}
      />

      {/* Horizon line — bright rim with layered glow, fading out at the edges */}
      <div
        className="absolute left-1/2"
        style={{
          top: "52%",
          transform: "translate(-50%, 0)",
          width: "260vw",
          height: "412vw",
          borderRadius: "50%",
          border: "1.5px solid rgba(168, 178, 255, 0.5)",
          boxShadow: [
            "0 0 24px 2px rgba(150, 160, 255, 0.35)",
            "0 0 90px 18px rgba(120, 130, 250, 0.16)",
            "0 0 220px 60px rgba(105, 96, 240, 0.07)",
            "inset 0 2px 44px rgba(140, 150, 255, 0.1)",
          ].join(", "),
          background: "transparent",
          WebkitMaskImage:
            "linear-gradient(90deg, transparent 18%, black 38%, black 62%, transparent 82%)",
          maskImage:
            "linear-gradient(90deg, transparent 18%, black 38%, black 62%, transparent 82%)",
        }}
      />

      {/* Center bloom — the arc burns brightest at its midpoint */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 34% 7% at 50% 52%, rgba(195, 202, 255, 0.4) 0%, rgba(140, 150, 255, 0.14) 45%, transparent 72%)",
        }}
      />

      {/* Wide faint halo hugging the horizon */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 13% at 50% 54%, rgba(110, 118, 240, 0.06) 0%, transparent 70%)",
        }}
      />

      {/* Custom background image */}
      {customBgUrl && (
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage: `url(${customBgUrl})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />
      )}
    </div>
  );
}
