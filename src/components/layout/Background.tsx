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

      {/* Soft depth glow behind the hero */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 55% 40% at 50% 38%, rgba(48, 44, 110, 0.35) 0%, transparent 70%)",
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

      {/* Center bloom — concentrates the light at the horizon apex */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 42% 9% at 50% 52%, rgba(186, 194, 255, 0.34) 0%, rgba(135, 145, 255, 0.12) 45%, transparent 72%)",
        }}
      />

      {/* Wide halo rising above the horizon */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 65% 16% at 50% 55%, rgba(96, 104, 220, 0.07) 0%, transparent 70%)",
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
