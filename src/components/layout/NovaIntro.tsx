import { useCallback, useEffect, useRef, useState } from "react";

const INTRO_EXIT_DELAY_MS = 1280;
const INTRO_FALLBACK_END_MS = 2050;
const REDUCED_EXIT_DELAY_MS = 430;
const REDUCED_FALLBACK_END_MS = 900;

interface NovaIntroProps {
	onComplete: () => void;
	onExitStart: () => void;
}

/**
 * A visual-only startup layer. AppShell stays mounted behind it so agent and
 * workspace initialization can finish while the signature is being drawn.
 */
export function NovaIntro({ onComplete, onExitStart }: NovaIntroProps) {
	const [isExiting, setIsExiting] = useState(false);
	const [reduceMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
	const [preboot] = useState(() => document.getElementById("nova-preboot"));
	const exitStartedRef = useRef(false);

	const finish = useCallback(() => {
		preboot?.remove();
		onComplete();
	}, [onComplete, preboot]);

	const beginExit = useCallback(() => {
		if (exitStartedRef.current) return;
		exitStartedRef.current = true;
		setIsExiting(true);
		preboot?.classList.add("nova-preboot-exiting");
		onExitStart();
	}, [onExitStart, preboot]);

	useEffect(() => {
		const startedBeforeReact = preboot ? performance.now() : 0;
		const exitAt = reduceMotion ? REDUCED_EXIT_DELAY_MS : INTRO_EXIT_DELAY_MS;
		const finishAt = reduceMotion ? REDUCED_FALLBACK_END_MS : INTRO_FALLBACK_END_MS;
		const handleTransitionEnd = (event: TransitionEvent) => {
			if (event.target === preboot && event.propertyName === "opacity") finish();
		};
		preboot?.addEventListener("transitionend", handleTransitionEnd);
		const exitTimer = window.setTimeout(
			beginExit,
			Math.max(0, exitAt - startedBeforeReact),
		);
		// WebViews can occasionally drop animationend while backgrounded or
		// during HMR. Never allow a decorative overlay to trap the application.
		const fallbackTimer = window.setTimeout(
			finish,
			Math.max(0, finishAt - startedBeforeReact),
		);

		return () => {
			preboot?.removeEventListener("transitionend", handleTransitionEnd);
			window.clearTimeout(exitTimer);
			window.clearTimeout(fallbackTimer);
		};
	}, [beginExit, finish, preboot, reduceMotion]);

	// On a real app launch the parser-created layer is already animating before
	// React loads. Reuse it as the single source of truth instead of restarting.
	if (preboot) return null;

	return (
		<div
			className={`nova-intro${isExiting ? " nova-intro-exiting" : ""}`}
			aria-hidden="true"
			onTransitionEnd={(event) => {
				if (isExiting && event.target === event.currentTarget && event.propertyName === "opacity") finish();
			}}
		>
			<div className="nova-intro-signature">
				<div className="nova-intro-halo" />
				<svg
					className="nova-intro-wordmark"
					viewBox="0 0 520 180"
					role="presentation"
					focusable="false"
				>
					<g className="nova-intro-ink">
						<path
							className="nova-intro-stroke nova-intro-stroke-n"
							pathLength="1"
							d="M 30 139 C 34 108, 37 66, 45 39 C 48 29, 54 27, 60 39 C 76 70, 88 107, 105 135 C 110 143, 115 139, 117 127 C 122 97, 124 62, 132 33"
						/>
						<path
							className="nova-intro-stroke nova-intro-stroke-o"
							pathLength="1"
							d="M 221 60 C 210 38, 178 32, 157 51 C 137 70, 137 111, 158 132 C 178 152, 213 142, 226 116 C 238 92, 233 67, 221 60 C 210 54, 192 62, 181 79"
						/>
						<path
							className="nova-intro-stroke nova-intro-stroke-v"
							pathLength="1"
							d="M 253 38 C 260 66, 270 105, 288 137 C 292 145, 297 145, 302 136 C 319 106, 332 70, 347 34"
						/>
						<path
							className="nova-intro-stroke nova-intro-stroke-a"
							pathLength="1"
							d="M 365 139 C 380 103, 394 66, 414 37 C 420 28, 427 30, 432 41 C 445 69, 455 105, 466 139 M 383 103 C 405 99, 430 97, 451 101 C 463 103, 477 102, 489 96"
						/>
					</g>
				</svg>
			</div>
		</div>
	);
}
