import type { LoopRecord } from "./types.js";

export type AskUserHandler = (question: string, options?: string[]) => Promise<string | undefined>;
export type ScheduleWakeupHandler = (
	prompt: string,
	delaySeconds: number,
) => Promise<LoopRecord> | LoopRecord;

export interface FlintcodeUiBridge {
	askUser?: AskUserHandler;
	scheduleWakeup?: ScheduleWakeupHandler;
}
