import { existsSync } from "node:fs";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";

export const TUI_THEMES = ["flintcode", "dark", "light"] as const;
export type TuiThemeName = (typeof TUI_THEMES)[number];

/**
 * Pi resolves custom themes from its agent dir. Flintcode keeps its own theme under
 * ~/.flintcode/themes, so point pi's theme loader there only for this synchronous
 * call and restore the environment immediately.
 */
export function initFlintcodeTheme(name: string, flintcodeHome: string): string {
	const requested = name === "qoder" || name === "tau" ? "flintcode" : name;
	const known = TUI_THEMES.includes(requested as TuiThemeName);
	const customThemeExists = existsSync(path.join(flintcodeHome, "themes", `${requested}.json`));
	const effective = known ? (requested as TuiThemeName) : customThemeExists ? requested : "dark";
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = flintcodeHome;
	try {
		initTheme(effective, false);
	} catch {
		initTheme("dark", false);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
	return effective;
}
