import { parseSchedule } from "@plumbline/shared";
import raw from "../../../../bots.schedule.json";

/** The runner's schedule: the same bots.schedule.json the Worker is built from, validated the same way. */
export const botsSchedule = parseSchedule(raw);
