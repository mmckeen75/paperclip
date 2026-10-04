import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshSpawnTarget,
  buildStopSshRunSessionsScript,
  parseSshRunSessionStopStatus,
  sshRunSessionRecordDir,
} from "./ssh.js";

const spec = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteCwd: "/srv/paperclip/workspace",
  remoteWorkspacePath: "/srv/paperclip/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
};

const RUN_ID = "4f17d9d6-a124-4432-9040-a93d53d1e9f2";

// The stop script waits 10 s between TERM and KILL; the tests wait 1 s.
function stopScript(runId: string, procRoot = "/proc") {
  return buildStopSshRunSessionsScript(runId).replace(/^wait=10$/m, "wait=1").replaceAll("/proc", procRoot);
}

function runSh(script: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", script], { env }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

// Fields of /proc/<pid>/stat after the command name: [state, ppid, pgrp, session, ...].
function statFields(pid: number) {
  return readFileSync(`/proc/${pid}/stat`, "utf8").split(")").at(-1)!.trim().split(" ");
}

function isRunning(pid: number) {
  try {
    const state = statFields(pid)[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("SSH run session tracking", () => {
  it("records the session before exec when the spawn carries a run id", async () => {
    const target = await buildSshSpawnTarget({
      spec,
      command: "claude",
      args: ["--print"],
      env: { PAPERCLIP_RUN_ID: RUN_ID },
    });
    const remoteScript = String(target.args.at(-1) ?? "");
    const record = remoteScript.indexOf(`.paperclip/run-sessions/${RUN_ID}`);
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(remoteScript.indexOf("exec env "));
    expect(remoteScript).toContain("/proc/$$/stat");
    await target.cleanup();
  });

  it("records nothing without a run id, or for a run id unsafe in a path", async () => {
    const envs: Record<string, string>[] = [{ FOO: "bar" }, { PAPERCLIP_RUN_ID: "../escape" }];
    for (const env of envs) {
      const target = await buildSshSpawnTarget({ spec, command: "node", args: [], env });
      expect(String(target.args.at(-1) ?? "")).not.toContain("run-sessions");
      await target.cleanup();
    }
    expect(sshRunSessionRecordDir("../escape")).toBeNull();
    expect(() => buildStopSshRunSessionsScript("a b")).toThrow();
  });

  it("parses the stop status line", () => {
    expect(parseSshRunSessionStopStatus("motd\npaperclip-run-sessions: stopped\n")).toBe("stopped");
    expect(parseSshRunSessionStopStatus("paperclip-run-sessions: untracked\n")).toBe("untracked");
    expect(parseSshRunSessionStopStatus("paperclip-run-sessions: no-record")).toBe("no-record");
    expect(parseSshRunSessionStopStatus("paperclip-run-sessions: stoppedx\n")).toBeNull();
    expect(parseSshRunSessionStopStatus("")).toBeNull();
  });
});

const describeLinux = existsSync("/proc/self/stat") ? describe : describe.skip;

describeLinux("SSH run session stop (real processes)", () => {
  let home: string;
  const children: ChildProcess[] = [];
  const pids: number[] = [];

  afterEach(async () => {
    for (const pid of pids.splice(0)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    for (const child of children.splice(0)) child.kill("SIGKILL");
    if (home) {
      await chmod(path.join(home, ".paperclip/run-sessions", RUN_ID, "unreadable"), 0o600).catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  });

  async function makeHome() {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-session-"));
    return home;
  }

  // Runs the remote script exactly as the spawn target sends it, in a new
  // session, as sshd does for a non-pty exec channel.
  async function spawnAsSshd(command: string, args: string[]) {
    const target = await buildSshSpawnTarget({
      spec: { ...spec, remoteCwd: home },
      command,
      args,
      env: { PAPERCLIP_RUN_ID: RUN_ID },
    });
    await target.cleanup();
    const child = spawn("sh", ["-c", String(target.args.at(-1))], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH, HOME: home },
    });
    children.push(child);
    return child;
  }

  async function readPids(file: string, count: number) {
    await until(async () => (await readFile(file, "utf8").catch(() => "")).trim().split(/\s+/).length >= count);
    return (await readFile(file, "utf8")).trim().split(/\s+/).map(Number);
  }

  it("stops every process in the recorded session, including a re-parented orphan and a TERM-ignoring member", async () => {
    await makeHome();
    const pidFile = path.join(home, "pids");
    // An orphan whose parent exits at once (re-parented away from the run),
    // a child, and a shell that ignores TERM and so needs KILL.
    const child = await spawnAsSshd("sh", ["-c",
      `(sleep 301 & echo $! >> ${pidFile}); sleep 302 & echo $! >> ${pidFile}; trap '' TERM; echo $$ >> ${pidFile}; wait`]);
    // A process of the same user in a separate session is not the run's.
    const outsider = spawn("sleep", ["303"], { detached: true, stdio: "ignore" });
    children.push(outsider);
    const [orphan, sleeper, shell] = await readPids(pidFile, 3);
    pids.push(orphan!, sleeper!);
    const recordFile = path.join(home, ".paperclip/run-sessions", RUN_ID, String(child.pid));
    await until(() => existsSync(recordFile));
    const [sid, leaderStart] = (await readFile(recordFile, "utf8")).trim().split(" ");
    expect(Number(sid)).toBe(child.pid);
    expect(Number(leaderStart)).toBeGreaterThan(0);
    // The orphan was re-parented away from the run's processes, and still
    // shares the run's session.
    await until(() => ![String(shell), String(child.pid)].includes(statFields(orphan!)[1]!));
    expect(statFields(orphan!)[3]).toBe(String(child.pid));

    const result = await runSh(stopScript(RUN_ID), { PATH: process.env.PATH, HOME: home });

    expect(result).toMatchObject({ code: 0 });
    expect(parseSshRunSessionStopStatus(result.stdout)).toBe("stopped");
    for (const pid of [orphan!, sleeper!, shell!]) expect(isRunning(pid)).toBe(false);
    expect(isRunning(outsider.pid!)).toBe(true);
    expect(existsSync(path.join(home, ".paperclip/run-sessions", RUN_ID))).toBe(false);
  }, 20_000);

  it("treats a recorded id whose pid was reused as an empty session", async () => {
    await makeHome();
    // A live session leader whose start time differs from the record: the
    // recorded session ended and its id was reused, so nothing is signalled.
    const reuser = spawn("sleep", ["304"], { detached: true, stdio: "ignore" });
    children.push(reuser);
    const dir = path.join(home, ".paperclip/run-sessions", RUN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, String(reuser.pid)), `${reuser.pid} 1\n`);

    const result = await runSh(stopScript(RUN_ID), { PATH: process.env.PATH, HOME: home });

    expect(parseSshRunSessionStopStatus(result.stdout)).toBe("stopped");
    expect(isRunning(reuser.pid!)).toBe(true);
  });

  it("reports no record, an untracked host, and fails on an unreadable or malformed record", async () => {
    await makeHome();
    const env = { PATH: process.env.PATH, HOME: home };
    expect(parseSshRunSessionStopStatus((await runSh(stopScript(RUN_ID), env)).stdout)).toBe("no-record");

    const dir = path.join(home, ".paperclip/run-sessions", RUN_ID);
    await mkdir(dir, { recursive: true });
    expect(parseSshRunSessionStopStatus((await runSh(stopScript(RUN_ID), env)).stdout)).toBe("no-record");

    await writeFile(path.join(dir, "untracked"), "");
    expect(parseSshRunSessionStopStatus((await runSh(stopScript(RUN_ID), env)).stdout)).toBe("untracked");

    await writeFile(path.join(dir, "123"), "123 not-a-number\n");
    expect(await runSh(stopScript(RUN_ID), env)).toMatchObject({ code: 5, stdout: "" });

    await rm(path.join(dir, "123"));
    if (process.getuid?.() !== 0) {
      await writeFile(path.join(dir, "unreadable"), "1 1\n");
      await chmod(path.join(dir, "unreadable"), 0o000);
      expect(await runSh(stopScript(RUN_ID), env)).toMatchObject({ code: 5, stdout: "" });
    }
  });

  it("never reports stopped while a member it cannot signal survives, even with an unreadable environment", async () => {
    await makeHome();
    // A fake /proc with one session member that no real process backs (so
    // kill fails, as for a process under another uid), whose environment is
    // unreadable. Membership comes from stat alone.
    const fakeProc = await mkdtemp(path.join(home, "proc-"));
    await symlink("/proc/self", path.join(fakeProc, "self"));
    await writeFile(path.join(fakeProc, "mounts"), "");
    const member = path.join(fakeProc, "999999");
    await mkdir(member);
    await writeFile(path.join(member, "stat"),
      "999999 (sudo helper) S 1 999998 999998 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 4242 0 0\n");
    await writeFile(path.join(member, "environ"), "");
    await chmod(path.join(member, "environ"), 0o000);
    const dir = path.join(home, ".paperclip/run-sessions", RUN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "999998"), "999998 4000\n");

    const result = await runSh(stopScript(RUN_ID, fakeProc), { PATH: process.env.PATH, HOME: home });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain("999999");
    expect(parseSshRunSessionStopStatus(result.stdout)).toBeNull();
    expect(existsSync(dir)).toBe(true);
  }, 20_000);
});
