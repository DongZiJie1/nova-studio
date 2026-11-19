import { useEffect, useRef, useState } from "react";
import manifest from "./glass-walkers-manifest.json";
import "./glass-walkers.css";

interface GlassWalkersRenderer {
	canvas: HTMLCanvasElement;
	gl: WebGL2RenderingContext;
	draw(
		target: HTMLCanvasElement,
		state: Record<string, unknown>,
		seconds: number,
	): void;
}
type RendererConstructor = new () => GlassWalkersRenderer;
const rendererWindow = window as Window & {
	GlassWalkersRenderer?: RendererConstructor;
};
const RENDERER_URL = `${import.meta.env.BASE_URL}${manifest.runtime.entry}`;
let rendererScript: Promise<RendererConstructor> | undefined;

function loadRenderer(): Promise<RendererConstructor> {
	if (rendererWindow.GlassWalkersRenderer)
		return Promise.resolve(rendererWindow.GlassWalkersRenderer);
	if (!rendererScript) {
		rendererScript = new Promise<RendererConstructor>((resolve, reject) => {
			const script = document.createElement("script");
			const finish = (error?: Error) => {
				clearTimeout(timeout);
				script.onload = script.onerror = null;
				if (error || !rendererWindow.GlassWalkersRenderer) {
					script.remove();
					reject(error ?? new Error("Glass Walkers renderer unavailable"));
				} else resolve(rendererWindow.GlassWalkersRenderer);
			};
			const timeout = window.setTimeout(
				() => finish(new Error("Glass Walkers renderer timed out")),
				15000,
			);
			script.src = RENDERER_URL;
			script.async = true;
			script.onload = () => finish();
			script.onerror = () =>
				finish(new Error("Glass Walkers renderer failed to load"));
			document.head.append(script);
		}).catch((error: unknown) => {
			rendererScript = undefined;
			throw error;
		});
	}
	return rendererScript;
}

export function GlassWalkersBackground({
	active = true,
}: {
	active?: boolean;
}) {
	const activeRef = useRef(active);
	const syncPlaybackRef = useRef<() => void>(() => {});
	useEffect(() => {
		activeRef.current = active;
		syncPlaybackRef.current();
	}, [active]);
	const host = useRef<HTMLDivElement>(null);
	const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
		"loading",
	);
	useEffect(() => {
		const container = host.current!;
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const composition = manifest.composition;
		const scene = {
			...composition.scene,
			...composition.canvas,
			speed: composition.motion.speed,
		};
		const duration =
			manifest.behavior.duration.baseSeconds / composition.motion.speed;
		let disposed = false;
		let renderer: GlassWalkersRenderer | undefined;
		let canvas: HTMLCanvasElement | undefined;
		let frame = 0;
		let lastTick: number | undefined;
		let seconds = 3;
		const pause = () => {
			cancelAnimationFrame(frame);
			frame = 0;
			lastTick = undefined;
		};
		const release = () => {
			pause();
			if (renderer) {
				renderer.canvas.removeEventListener("webglcontextlost", onError);
				renderer.gl.getExtension("WEBGL_lose_context")?.loseContext();
				renderer = undefined;
			}
			canvas?.remove();
			canvas = undefined;
		};
		const onError = () => {
			release();
			if (!disposed) setStatus("unavailable");
		};
		const draw = () => {
			if (!renderer || !canvas) return;
			renderer.draw(canvas, scene, seconds);
			canvas.dataset.time = seconds.toFixed(3);
		};
		const tick = (now: number) => {
			frame = 0;
			if (disposed) {
				pause();
				return;
			}
			if (!activeRef.current || document.hidden || reducedMotion.matches) {
				syncPlayback();
				return;
			}
			if (lastTick !== undefined)
				seconds = (seconds + (now - lastTick) / 1000) % duration;
			lastTick = now;
			try {
				draw();
			} catch {
				onError();
				return;
			}
			frame = requestAnimationFrame(tick);
		};
		const syncPlayback = () => {
			if (!renderer || disposed) return;
			if (reducedMotion.matches) {
				pause();
				if (seconds !== 3) {
					seconds = 3;
					try {
						draw();
					} catch {
						onError();
					}
				}
				return;
			}
			if (!activeRef.current || document.hidden) pause();
			else if (!frame) frame = requestAnimationFrame(tick);
		};
		syncPlaybackRef.current = syncPlayback;
		const onMotionChange = syncPlayback;
		document.addEventListener("visibilitychange", syncPlayback);
		reducedMotion.addEventListener("change", onMotionChange);
		void (async () => {
			try {
				const Renderer = await loadRenderer();
				if (disposed) return;
				renderer = new Renderer();
				renderer.canvas.addEventListener("webglcontextlost", onError);
				canvas = document.createElement("canvas");
				// Match the official preview's render resolution and the bundled poster.
				const scale = Math.min(
					1,
					1100 / composition.canvas.width,
					850 / composition.canvas.height,
				);
				canvas.width = Math.round(composition.canvas.width * scale);
				canvas.height = Math.round(composition.canvas.height * scale);
				draw();
				container.append(canvas);
				setStatus("ready");
				syncPlayback();
			} catch {
				if (!disposed) onError();
			}
		})();
		return () => {
			disposed = true;
			document.removeEventListener("visibilitychange", syncPlayback);
			reducedMotion.removeEventListener("change", onMotionChange);
			syncPlaybackRef.current = () => {};
			release();
		};
	}, []);
	return (
		<div
			className="glass-walkers-background"
			data-status={status}
			data-active={active}
			aria-hidden="true"
		>
			<img
				className="glass-walkers-poster"
				src={`${import.meta.env.BASE_URL}images/glass-walkers-poster.png`}
				alt=""
				fetchPriority="high"
				draggable={false}
			/>
			<div className="glass-walkers-player-host" ref={host} />
			{status === "unavailable" && (
				<span className="glass-walkers-fallback">动态背景暂不可用</span>
			)}
		</div>
	);
}
