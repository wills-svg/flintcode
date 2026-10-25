import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PermissionEngine } from "./permissions.js";

export const PLAN_SAFE_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"web_fetch",
	"WebSearch",
	"WebFetch",
	"ask_user",
	"TodoWrite",
	"todo_write",
	"todo_read",
	"todo_list",
	"memory_search",
	"memory_list",
	"goal_get",
	"EnterPlanMode",
	"ExitPlanMode",
	"bash_output",
	"task_list",
	"agent_output",
	"ScheduleWakeup",
];

export type PlanApprovalHandler = (plan: string) => Promise<boolean>;
export type PlanChangeHandler = (active: boolean) => void;

export class PlanController {
	private session?: AgentSession;
	private engine?: PermissionEngine;
	private active = false;
	private savedTools: string[] = [];
	private approvalHandler?: PlanApprovalHandler;
	private changeHandler?: PlanChangeHandler;
	private persistHandler?: (active: boolean, plan?: string) => void;

	constructor(engine?: PermissionEngine) {
		this.engine = engine;
	}

	setEngine(engine: PermissionEngine): void {
		this.engine = engine;
		if (this.active) engine.setPlanMode(true);
	}

	setApprovalHandler(handler: PlanApprovalHandler | undefined): void {
		this.approvalHandler = handler;
	}

	setChangeHandler(handler: PlanChangeHandler | undefined): void {
		this.changeHandler = handler;
	}

	setPersistHandler(handler: ((active: boolean, plan?: string) => void) | undefined): void {
		this.persistHandler = handler;
	}

	attachSession(session: AgentSession): void {
		if (this.session === session) return;
		this.session = session;
		if (this.active) {
			this.active = false;
			this.savedTools = [];
			this.engine?.setPlanMode(false);
			this.changeHandler?.(false);
		}
	}

	isActive(): boolean {
		return this.active;
	}

	enter(): string {
		if (this.active) return "Plan mode is already active.";
		const session = this.requireSession();
		this.savedTools = session.getActiveToolNames();
		const available = new Set(this.savedTools);
		const nextTools = PLAN_SAFE_TOOL_NAMES.filter(
			(name) => available.has(name) || name === "ExitPlanMode",
		);
		session.setActiveToolsByName([...new Set(nextTools)]);
		this.active = true;
		this.engine?.setPlanMode(true);
		this.changeHandler?.(true);
		this.persistHandler?.(true);
		return "Plan mode enabled. Investigate read-only, build a concrete plan, and call ExitPlanMode when ready. File edits and state-changing commands are blocked.";
	}

	async exitByModel(plan: string): Promise<string> {
		if (!this.active) return "Plan mode is not active.";
		const approved = this.approvalHandler ? await this.approvalHandler(plan) : false;
		if (!approved) {
			return "Plan was not approved. Continue planning or gather more information.";
		}
		this.restore();
		this.persistHandler?.(false, plan);
		return "Plan approved. Plan mode is off and the previous tools are restored. Execute the plan.";
	}

	exitByCommand(): string {
		if (!this.active) return "Plan mode is not active.";
		this.restore();
		this.persistHandler?.(false);
		return "Plan mode disabled.";
	}

	private restore(): void {
		const session = this.requireSession();
		this.active = false;
		this.engine?.setPlanMode(false);
		const tools = this.savedTools.length > 0 ? this.savedTools : ["read", "bash", "edit", "write"];
		session.setActiveToolsByName(tools);
		this.savedTools = [];
		this.changeHandler?.(false);
	}

	private requireSession(): AgentSession {
		if (!this.session) throw new Error("Plan mode is not attached to a session yet.");
		return this.session;
	}
}

export const PLAN_SYSTEM_PROMPT = `## Flintcode plan mode

You are in plan mode. Your job is to research and propose, not to change things.
- Use read-only tools to inspect the workspace. Do not edit files, write files, or run state-changing shell commands.
- Ask the user for clarification with ask_user when a decision materially changes the plan.
- Keep todos updated if you use TodoWrite.
- Produce a concrete, ordered implementation plan with file paths, risks, and verification steps.
- When the plan is ready, call ExitPlanMode with the complete plan text. The user must approve it before tools are restored.`;
