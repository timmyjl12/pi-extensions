// Owned child-process teardown with Windows PID-reuse protection.
//
// A running root is killed by its exact PID with taskkill /T /F. Once that root
// has exited, its numeric PID may already name somebody else's process: CIM
// must then confirm both the executable image and a creation timestamp within
// five seconds of our spawn before taskkill is allowed. Otherwise teardown is
// limited to the stdio handles owned by this ChildProcess.

import { execFile, type ChildProcess } from "node:child_process";
import { basename } from "node:path";

export const PROCESS_KILL_TIMEOUT_MS = 5_000;
export const PROCESS_IDENTITY_TIME_TOLERANCE_MS = 5_000;

export type ProcessExec = (file: string, args: string[], timeoutMs: number) => Promise<string>;

type SpawnedIdentity = { pid: number; image: string; spawnedAtMs: number };

const spawnedIdentities = new WeakMap<ChildProcess, SpawnedIdentity>();

/** CIM reports agy.exe even when spawn used the bare name agy. Normalize only
 *  the Windows executable suffix; the rest of the image identity stays exact. */
const normalizeImageName = (image: string): string =>
	basename(image).toLowerCase().replace(/\.exe$/, "");

/** Execute a short system command with bounded time/output and no shell. */
const execTextFile: ProcessExec = (file, args, timeoutMs) =>
	new Promise<string>((resolve, reject) => {
		execFile(
			file,
			args,
			{ encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(stdout.trim());
			},
		);
	});

/** Capture identity at spawn time; looking it up at kill time would make the
 *  creation-time check meaningless. Returns the same child for call-site chaining. */
export function trackSpawnedIdentity<T extends ChildProcess>(
	child: T,
	image: string,
	spawnedAtMs = Date.now(),
): T {
	if (child.pid !== undefined) {
		spawnedIdentities.set(child, {
			pid: child.pid,
			image: normalizeImageName(image),
			spawnedAtMs,
		});
	}
	return child;
}

const isRunning = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

/** Verify an exited root before any after-exit taskkill. The CIM Name is the
 *  executable image basename; CreationDate rejects a recycled numeric PID. */
export async function verifyExitedChildIdentity(
	child: ChildProcess,
	execIdentityQuery: ProcessExec = execTextFile,
): Promise<boolean> {
	const identity = spawnedIdentities.get(child);
	if (!identity || child.pid !== identity.pid) return false;
	const script =
		`$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${identity.pid}' -ErrorAction Stop; ` +
		"if ($null -eq $p) { exit 3 }; " +
		"[pscustomobject]@{ Name = [string]$p.Name; CreationDate = " +
		"$p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } | ConvertTo-Json -Compress";
	try {
		const output = await execIdentityQuery(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
			PROCESS_KILL_TIMEOUT_MS,
		);
		const parsed = JSON.parse(output) as { Name?: unknown; CreationDate?: unknown };
		if (typeof parsed.Name !== "string" || typeof parsed.CreationDate !== "string") return false;
		const createdAtMs = Date.parse(parsed.CreationDate);
		return (
			normalizeImageName(parsed.Name) === identity.image &&
			Number.isFinite(createdAtMs) &&
			Math.abs(createdAtMs - identity.spawnedAtMs) <= PROCESS_IDENTITY_TIME_TOLERANCE_MS
		);
	} catch {
		return false;
	}
}

export interface TerminateProcessTreeOptions {
	/** Test seams; production uses bounded execFile calls. */
	execTreeKill?: ProcessExec;
	execIdentityQuery?: ProcessExec;
	platform?: NodeJS.Platform;
	killProcess?: (pid: number, signal: NodeJS.Signals) => void;
	/** Stream driver uses a detached POSIX process group; one-shot helpers do not. */
	posixGroup?: boolean;
	/** Initial POSIX signal (group escalation remains SIGKILL after 750ms). */
	signal?: NodeJS.Signals;
	onError?: (error: unknown) => void;
}

/** Terminate only the supplied owned child/tree, then destroy only its stdio.
 *  The default Windows command paths are bounded by PROCESS_KILL_TIMEOUT_MS;
 *  finally runs even after command failure so inherited pipes cannot hold a
 *  caller open indefinitely. */
export async function terminateProcessTree(
	child: ChildProcess,
	options: TerminateProcessTreeOptions = {},
): Promise<void> {
	const platform = options.platform ?? process.platform;
	const signal = options.signal ?? "SIGTERM";
	const onError = options.onError ?? (() => undefined);
	const killProcess = options.killProcess ?? ((pid: number, sig: NodeJS.Signals) => {
		process.kill(pid, sig);
	});
	try {
		if (platform !== "win32") {
			if (options.posixGroup && child.pid !== undefined) {
				const pid = child.pid;
				const signalGroup = (sig: NodeJS.Signals): void => {
					try {
						// A dead root can leave a valid PGID with live members.
						killProcess(-pid, sig);
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== "ESRCH") onError(err);
					}
				};
				signalGroup(signal);
				const escalation = setTimeout(() => signalGroup("SIGKILL"), 750);
				escalation.unref();
			} else if (isRunning(child)) {
				child.kill(signal);
			}
			return;
		}

		const execTreeKill = options.execTreeKill ?? execTextFile;
		if (child.pid !== undefined) {
			const running = isRunning(child);
			// Running roots retain exact-PID behavior. An exited root must prove
			// image + creation time before its numeric PID can be signaled again.
			const verified =
				running ||
				(await verifyExitedChildIdentity(
					child,
					options.execIdentityQuery ?? execTextFile,
				));
			if (verified) {
				try {
					await execTreeKill(
						"taskkill.exe",
						["/pid", String(child.pid), "/T", "/F"],
						PROCESS_KILL_TIMEOUT_MS,
					);
				} catch (err) {
					onError(err);
					if (isRunning(child)) child.kill(signal);
				}
			}
		} else if (isRunning(child)) {
			child.kill(signal);
		}
	} catch (err) {
		onError(err);
	} finally {
		// A dead root does not close pipes inherited by surviving descendants.
		child.stdin?.destroy();
		child.stdout?.destroy();
		child.stderr?.destroy();
	}
}
