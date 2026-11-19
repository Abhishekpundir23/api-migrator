// Synthetic input for the read-only assessment. This file is never executed.
import { Knock } from "@knocklabs/node";

const notifications = new Knock(process.env.KNOCK_KEY!);
await notifications.notify("welcome", { recipients: ["example-recipient"] });
