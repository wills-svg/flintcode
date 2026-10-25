import { createMcpExtension, type InlineExtension, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FlintcodeConfig } from "../core/types.js";
import type { FlintcodePaths } from "../core/paths.js";
import type { PermissionEngine } from "../core/permissions.js";
import type { PlanController } from "../core/plan.js";
import type { HookRunner } from "../core/hooks.js";
import type { MemoryService } from "../core/memory.js";
import type { GoalService } from "../core/goals.js";
import { createPermissionExtension } from "../core/permissions.js";
import { createPlanExtension } from "./plan.js";
import { createHooksExtension } from "./hooks.js";
import { createContextExtension } from "./context.js";
import { createTodoExtension } from "./todos.js";
import { createMemoryExtension } from "./memory.js";
import { createGoalExtension } from "./goals.js";
import { createWebExtension } from "./web.js";
import { createBackgroundBashExtension } from "./background-bash.js";
import { createSubagentExtension } from "./subagent.js";
import { createAskUserExtension } from "./ask-user.js";
import { createLoopExtension } from "./loop.js";
import { createOutputStyleExtension } from "./output-style.js";
import { createFlintcodeIdentityExtension } from "./identity.js";
import { savePlan } from "../core/plans.js";
import type { FlintcodeUiBridge } from "../core/ui-bridge.js";

export interface FlintcodeExtensionOptions {
	paths: FlintcodePaths;
	config: FlintcodeConfig;
	cwd: string;
	projectTrusted: boolean;
	modelRuntime: ModelRuntime;
	permissionEngine: PermissionEngine;
	planController: PlanController;
	memory: MemoryService;
	goals: GoalService;
	hooks?: HookRunner;
	uiBridge?: FlintcodeUiBridge;
}

export function createFlintcodeExtensions(options: FlintcodeExtensionOptions): InlineExtension[] {
	const extensions: InlineExtension[] = [];
	if (options.hooks) extensions.push(createHooksExtension(options.hooks));
	extensions.push(createFlintcodeIdentityExtension());
	extensions.push(createOutputStyleExtension(() => options.config.ui.outputStyle));
	extensions.push(createContextExtension(options.memory, options.goals));
	extensions.push(createPermissionExtension(options.permissionEngine));
	extensions.push(
		createPlanExtension(options.planController, {
			savePlan: (plan) => savePlan(options.paths, options.cwd, plan),
		}),
	);
	extensions.push(createAskUserExtension(options.uiBridge ?? {}));
	extensions.push(createLoopExtension(options.uiBridge ?? {}));
	extensions.push(createTodoExtension(options.paths));
	extensions.push(createMemoryExtension(options.paths, options.cwd));
	extensions.push(createGoalExtension(options.paths, options.cwd));
	extensions.push(createWebExtension(options.config));
	extensions.push(createBackgroundBashExtension(options.paths));
	extensions.push(
		createSubagentExtension({
			paths: options.paths,
			config: options.config,
			cwd: options.cwd,
			projectTrusted: options.projectTrusted,
			modelRuntime: options.modelRuntime,
			permissionEngine: options.permissionEngine,
		}),
	);
	extensions.push(createMcpExtension());
	return extensions;
}
