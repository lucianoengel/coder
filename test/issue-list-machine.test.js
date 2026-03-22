import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchGithubIssues,
  fetchGitlabIssues,
} from "../src/machines/develop/issue-list.machine.js";

// --- fetchGithubIssues ---

test("fetchGithubIssues throws on missing binary (ENOENT)", () => {
  const stub = () => ({
    error: new Error("spawn gh ENOENT"),
    status: null,
    stdout: "",
    stderr: "",
  });
  assert.throws(
    () => fetchGithubIssues("/tmp", { _spawnSync: stub }),
    /gh:.*ENOENT/,
  );
});

test("fetchGithubIssues throws on non-zero exit with stderr", () => {
  const stub = () => ({
    error: null,
    status: 1,
    stderr: "auth token expired",
    stdout: "",
  });
  assert.throws(
    () => fetchGithubIssues("/tmp", { _spawnSync: stub }),
    (err) => {
      assert.match(err.message, /gh issue list failed/);
      assert.match(err.message, /exit 1/);
      assert.match(err.message, /auth token expired/);
      return true;
    },
  );
});

test("fetchGithubIssues throws on invalid JSON output", () => {
  const stub = () => ({
    error: null,
    status: 0,
    stdout: "not json{",
    stderr: "",
  });
  assert.throws(
    () => fetchGithubIssues("/tmp", { _spawnSync: stub }),
    /invalid JSON/,
  );
});

test("fetchGithubIssues throws on non-array JSON output", () => {
  const stub = () => ({
    error: null,
    status: 0,
    stdout: '{"foo":1}',
    stderr: "",
  });
  assert.throws(
    () => fetchGithubIssues("/tmp", { _spawnSync: stub }),
    /non-array JSON/,
  );
});

test("fetchGithubIssues returns [] on empty stdout", () => {
  const stub = () => ({
    error: null,
    status: 0,
    stdout: "",
    stderr: "",
  });
  assert.deepEqual(fetchGithubIssues("/tmp", { _spawnSync: stub }), []);
});

test("fetchGithubIssues returns [] on empty JSON array", () => {
  const stub = () => ({
    error: null,
    status: 0,
    stdout: "[]",
    stderr: "",
  });
  assert.deepEqual(fetchGithubIssues("/tmp", { _spawnSync: stub }), []);
});

test("fetchGithubIssues returns parsed array on valid JSON", () => {
  const payload = [
    {
      number: 1,
      title: "test",
      body: "",
      labels: [],
      url: "u",
      comments: [],
    },
  ];
  const stub = () => ({
    error: null,
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  });
  const result = fetchGithubIssues("/tmp", { _spawnSync: stub });
  assert.equal(result.length, 1);
  assert.equal(result[0].number, 1);
  assert.equal(result[0].title, "test");
});

// --- fetchGitlabIssues ---

test("fetchGitlabIssues throws on missing binary (ENOENT)", () => {
  const stub = () => ({
    error: new Error("spawn glab ENOENT"),
    status: null,
    stdout: "",
    stderr: "",
  });
  assert.throws(
    () => fetchGitlabIssues("/tmp", { _spawnSync: stub }),
    /glab:.*ENOENT/,
  );
});

test("fetchGitlabIssues throws on non-zero exit with stderr", () => {
  const stub = () => ({
    error: null,
    status: 1,
    stderr: "token revoked",
    stdout: "",
  });
  assert.throws(
    () => fetchGitlabIssues("/tmp", { _spawnSync: stub }),
    (err) => {
      assert.match(err.message, /glab issue list failed/);
      assert.match(err.message, /exit 1/);
      assert.match(err.message, /token revoked/);
      return true;
    },
  );
});

test("fetchGitlabIssues throws on invalid JSON output", () => {
  const stub = () => ({
    error: null,
    status: 0,
    stdout: "{broken",
    stderr: "",
  });
  assert.throws(
    () => fetchGitlabIssues("/tmp", { _spawnSync: stub }),
    /invalid JSON/,
  );
});

test("fetchGitlabIssues throws on non-array JSON output", () => {
  const stub = () => ({
    error: null,
    status: 0,
    stdout: '{"foo":1}',
    stderr: "",
  });
  assert.throws(
    () => fetchGitlabIssues("/tmp", { _spawnSync: stub }),
    /non-array JSON/,
  );
});

test("fetchGitlabIssues returns [] on empty stdout (first page)", () => {
  const stub = () => ({
    error: null,
    status: 0,
    stdout: "",
    stderr: "",
  });
  assert.deepEqual(fetchGitlabIssues("/tmp", { _spawnSync: stub }), []);
});

test("fetchGitlabIssues returns [] on empty JSON array", () => {
  const stub = () => ({
    error: null,
    status: 0,
    stdout: "[]",
    stderr: "",
  });
  assert.deepEqual(fetchGitlabIssues("/tmp", { _spawnSync: stub }), []);
});

test("fetchGitlabIssues returns mapped data on valid JSON", () => {
  const payload = [
    {
      iid: 7,
      title: "Fix CI",
      description: "Long description here",
      labels: [{ name: "bug" }],
      web_url: "https://gl.example.com/7",
    },
  ];
  const stub = () => ({
    error: null,
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  });
  const result = fetchGitlabIssues("/tmp", { _spawnSync: stub });
  assert.equal(result.length, 1);
  assert.equal(result[0].iid, 7);
  assert.equal(result[0].title, "Fix CI");
  assert.equal(result[0].description, "Long description here");
  assert.deepEqual(result[0].labels, ["bug"]);
  assert.equal(result[0].web_url, "https://gl.example.com/7");
});

test("fetchGitlabIssues handles string labels alongside object labels", () => {
  const payload = [
    {
      iid: 10,
      title: "Mixed labels",
      description: "",
      labels: ["plain-string", { name: "object-label" }, 42],
      web_url: "https://gl.example.com/10",
    },
  ];
  const stub = () => ({
    error: null,
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  });
  const result = fetchGitlabIssues("/tmp", { _spawnSync: stub });
  assert.deepEqual(result[0].labels, ["plain-string", "object-label", "42"]);
});

test("fetchGitlabIssues truncates description to 500 chars", () => {
  const longDesc = "x".repeat(600);
  const payload = [
    {
      iid: 11,
      title: "Long desc",
      description: longDesc,
      labels: [],
      web_url: "https://gl.example.com/11",
    },
  ];
  const stub = () => ({
    error: null,
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  });
  const result = fetchGitlabIssues("/tmp", { _spawnSync: stub });
  assert.equal(result[0].description.length, 500);
});

test("fetchGitlabIssues paginates across multiple pages", () => {
  let callCount = 0;
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    iid: i + 1,
    title: `Issue ${i + 1}`,
    description: "",
    labels: [],
    web_url: `https://gl.example.com/${i + 1}`,
  }));
  const page2 = [
    {
      iid: 101,
      title: "Issue 101",
      description: "",
      labels: [],
      web_url: "https://gl.example.com/101",
    },
  ];

  const stub = () => {
    callCount++;
    return {
      error: null,
      status: 0,
      stdout: JSON.stringify(callCount === 1 ? page1 : page2),
      stderr: "",
    };
  };
  const result = fetchGitlabIssues("/tmp", { _spawnSync: stub });
  assert.equal(result.length, 101);
  assert.equal(result[0].iid, 1);
  assert.equal(result[100].iid, 101);
  assert.equal(callCount, 2);
});
