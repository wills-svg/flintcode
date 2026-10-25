const FRAMES = ["◐", "◓", "◑", "◒"] as const;

export function spinnerFrame(now = Date.now()): string {
	return FRAMES[Math.floor(now / 180) % FRAMES.length];
}
