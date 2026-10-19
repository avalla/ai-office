import { describe, expect, test } from "vitest";
import {
  coordinationExposureRegistry,
  exposeItem,
  redactionMarker,
  scrubCredentials,
} from "@ai-office/application/coordination/coordination-exposure.ts";

describe("coordination exposure registry", () => {
  test("lists exactly the exposed fields and their classes", () => {
    const classes = Object.fromEntries(
      Object.entries(coordinationExposureRegistry).map(([name, fields]) => [
        name,
        Object.fromEntries(
          Object.entries(fields).map(([field, exposure]) => [
            field,
            exposure.dataClass,
          ]),
        ),
      ]),
    );
    expect(classes).toEqual({
      milestones: { milestoneId: "P", title: "T", status: "P" },
      tasks: {
        taskId: "P",
        title: "T",
        status: "P",
        priority: "P",
        milestoneIds: "P",
        requirementIds: "P",
        prerequisiteIds: "P",
      },
      requirements: {
        requirementId: "P",
        key: "P",
        title: "T",
        status: "P",
        milestoneId: "P",
        taskIds: "P",
      },
      dependencies: { taskId: "P", dependsOnTaskId: "P" },
      blockers: {
        taskId: "P",
        status: "P",
        reasons: "P",
        unmetPrerequisiteIds: "P",
      },
      runnable: { taskId: "P", status: "P", priority: "P" },
    });
  });

  test("copies registered fields only and never an unregistered one", () => {
    const source = {
      taskId: "t1",
      title: "Title",
      status: "pending",
      priority: 2,
      milestoneIds: ["m"],
      requirementIds: [],
      prerequisiteIds: ["t0"],
      description: "SECRET-DESCRIPTION",
      agentOutput: "SECRET-OUTPUT",
    };
    const item = exposeItem("tasks", source, ["P", "T"]);
    expect(item).toEqual({
      taskId: "t1",
      title: "Title",
      status: "pending",
      priority: 2,
      milestoneIds: ["m"],
      requirementIds: [],
      prerequisiteIds: ["t0"],
    });
    expect(JSON.stringify(item)).not.toContain("SECRET");
    // Arrays are copies, so a caller cannot reach the read model through them.
    expect(item.prerequisiteIds).not.toBe(source.prerequisiteIds);
  });

  test("drops T fields when only P is allowed", () => {
    expect(
      exposeItem(
        "requirements",
        {
          requirementId: "r",
          key: "R-1",
          title: "Title",
          status: "proposed",
          milestoneId: null,
          taskIds: [],
        },
        ["P"],
      ),
    ).toEqual({
      requirementId: "r",
      key: "R-1",
      status: "proposed",
      milestoneId: null,
      taskIds: [],
    });
  });

  test("ignores inherited properties", () => {
    const source = Object.create({ title: "inherited" }) as object;
    Object.assign(source, { milestoneId: "m", status: "active" });
    expect(exposeItem("milestones", source, ["P", "T"])).toEqual({
      milestoneId: "m",
      status: "active",
    });
  });

  test("truncates text at 256 code points and flags the field", () => {
    const long = `${"x".repeat(255)}😀😀`;
    const item = exposeItem(
      "milestones",
      { milestoneId: "m", title: long, status: "active" },
      ["P", "T"],
    );
    expect(item.title).toBe(`${"x".repeat(255)}😀`);
    expect(Array.from(item.title as string)).toHaveLength(256);
    expect(item.truncatedFields).toEqual(["title"]);
    const exact = exposeItem(
      "milestones",
      { milestoneId: "m", title: "y".repeat(256), status: "active" },
      ["P", "T"],
    );
    expect(exact).not.toHaveProperty("truncatedFields");
  });

  test("cuts relationship lists at 100 entries and flags them", () => {
    const ids = Array.from({ length: 150 }, (_, index) => `t${index}`);
    const item = exposeItem(
      "requirements",
      {
        requirementId: "r",
        key: "R-1",
        title: "Req",
        status: "accepted",
        milestoneId: null,
        taskIds: ids,
      },
      ["P", "T"],
    );
    expect(item.taskIds).toEqual(ids.slice(0, 100));
    expect(item.truncatedFields).toEqual(["taskIds"]);
    const exact = exposeItem(
      "requirements",
      {
        requirementId: "r",
        key: "R-1",
        title: "Req",
        status: "accepted",
        milestoneId: null,
        taskIds: ids.slice(0, 100),
      },
      ["P", "T"],
    );
    expect(exact).not.toHaveProperty("truncatedFields");
  });

  test("never leaves a partial redaction marker at the cut", () => {
    const token = ["gh", "p_", "q".repeat(36)].join("");
    const item = exposeItem(
      "milestones",
      {
        milestoneId: "m",
        title: `${"x".repeat(250)}${token}${"y".repeat(10)}`,
        status: "active",
      },
      ["P", "T"],
    );
    expect(item.title).toBe("x".repeat(250));
    expect(item.truncatedFields).toEqual(["title"]);
  });

  test("bounds very long stored text before scrubbing and flags the cut", () => {
    const item = exposeItem(
      "milestones",
      { milestoneId: "m", title: "z".repeat(100_000), status: "active" },
      ["P", "T"],
    );
    expect(item.title).toBe("z".repeat(256));
    expect(item.truncatedFields).toEqual(["title"]);
  });

  test("scrubs before truncating, so a token at the boundary is still removed", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const item = exposeItem(
      "milestones",
      { milestoneId: "m", title: `${"x".repeat(240)}${token}`, status: "active" },
      ["P", "T"],
    );
    expect(item.title).toBe(`${"x".repeat(240)}${redactionMarker}`);
    expect(item).not.toHaveProperty("truncatedFields");
  });
});

describe("credential scrubber", () => {
  // Synthetic samples are assembled at run time, so the repository holds no
  // credential-shaped literal that a secret scanner or a redacting tool would
  // rewrite before a reader sees it.
  const join = (...parts: string[]) => parts.join("");
  const samples: [string, string][] = [
    ["GitHub classic token", join("gh", "p_", "A".repeat(36))],
    ["GitHub fine-grained token", join("github", "_pat_", "B".repeat(40))],
    ["OpenAI key", join("sk", "-", "c".repeat(40))],
    ["Anthropic key", join("sk", "-ant-api03-", "d".repeat(40))],
    ["Slack token", join("xo", "xb-", "1".repeat(20))],
    ["AWS access key id", join("AK", "IA", "ABCDEFGHIJKLMNOP")],
    ["Google API key", join("AI", "za", "e".repeat(35))],
    [
      "JWT",
      join("ey", "J", "hbGciOiJIUzI1NiJ9", ".", "ey", "J", "zdWIiOiIxMjM0NTY3OCJ9", ".", "c2lnbmF0dXJlLXZhbHVl"),
    ],
    ["bearer header value", join("Bearer ", "f".repeat(32))],
    ["basic header value", join("Basic ", "Zm9vOmJhcmJhemJhcXV4cXV1eA==")],
    ["Stripe live key", join("sk", "_live_", "g".repeat(24))],
    ["Stripe restricted key", join("rk", "_test_", "h".repeat(24))],
    ["GitLab token", join("gl", "pat-", "i".repeat(20))],
    ["npm token", join("np", "m_", "j".repeat(36))],
    ["Google OAuth token", join("ya", "29.", "k".repeat(30))],
    ["password assignment", join("password", "=", "hunter22")],
    ["API key assignment", join("api_key", ": ", "l".repeat(12))],
    ["AWS secret assignment", join("aws_secret_access_key", "=", "m".repeat(40))],
    [
      "token split by a zero-width space",
      join("gh", "p_", "n".repeat(10), "​", "n".repeat(26)),
    ],
    [
      "private key block",
      join("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIabc\n-----END RSA ", "PRIVATE KEY-----"),
    ],
  ];
  test.each(samples)("redacts a %s", (_shape, secret) => {
    const scrubbed = scrubCredentials(`before ${secret} after`);
    expect(scrubbed).toBe(`before ${redactionMarker} after`);
  });

  test("redacts JSON-style and quoted secret values whole", () => {
    expect(
      scrubCredentials(['config {"pass', 'word":"hunter2hunter2"} ok'].join("")),
    ).toBe(`config {"${redactionMarker}} ok`);
    expect(
      scrubCredentials(['pass', 'word: "correct horse battery" done'].join("")),
    ).toBe(`${redactionMarker} done`);
    expect(scrubCredentials(["xo", "xe-", "1".repeat(20)].join(""))).toBe(
      redactionMarker,
    );
    expect(
      scrubCredentials(["gh", "p_", "r".repeat(10), "͏", "r".repeat(26)].join("")),
    ).toBe(redactionMarker);
  });

  test("redacts escaped and unterminated quoted values", () => {
    expect(
      scrubCredentials(["pass", "word: ", '"QQQ\\"ZZZ WWW VVV"', " end"].join("")),
    ).toBe(`${redactionMarker} end`);
    expect(
      scrubCredentials(["pass", "word: ", '"hunter2hunter2'].join("")),
    ).toBe(redactionMarker);
    expect(scrubCredentials("Rotate token: weekly")).toBe(
      "Rotate token: weekly",
    );
  });

  test("redacts every word of an unterminated quoted value, to the end of its line", () => {
    expect(
      scrubCredentials(["Note pass", 'word: "correct horse battery staple'].join("")),
    ).toBe(`Note ${redactionMarker}`);
    expect(
      scrubCredentials(["pass", 'word: "ab\\"cdefghij more words'].join("")),
    ).toBe(redactionMarker);
    expect(
      scrubCredentials(
        ["sec", "ret='two words here\nNext line stays"].join(""),
      ),
    ).toBe(`${redactionMarker}\nNext line stays`);
    // A trailing backslash at the end of the line or text is redacted too.
    expect(
      scrubCredentials(["pass", 'word: "correct horse battery\\'].join("")),
    ).toBe(redactionMarker);
    expect(
      scrubCredentials(["tok", 'en: "longsecretvalue\\\nkept'].join("")),
    ).toBe(`${redactionMarker}\nkept`);
    expect(
      scrubCredentials(["sec", "ret: 'two words\\\r\nkept"].join("")),
    ).toBe(`${redactionMarker}\r\nkept`);
    // An odd run of backslashes, and an escaped closing quote, still end in
    // an unterminated value.
    expect(scrubCredentials(["pass", 'word: "abc\\\\\\'].join(""))).toBe(
      redactionMarker,
    );
    expect(
      scrubCredentials(["pass", 'word: "longsecret\\"\nkept'].join("")),
    ).toBe(`${redactionMarker}\nkept`);
    // Accepted over-redaction: an opening quote with nothing after it.
    expect(scrubCredentials(["pass", 'word: "'].join(""))).toBe(redactionMarker);
    // A long backslash run is scanned in bounded time.
    const started = performance.now();
    expect(
      scrubCredentials(["pass", 'word: "', "\\".repeat(4096)].join("")),
    ).toBe(redactionMarker);
    expect(performance.now() - started).toBeLessThan(1000);
    // An escaped line break inside a closed quote keeps the whole value.
    expect(
      scrubCredentials(["pass", 'word = "x\\\ny secret rest" end'].join("")),
    ).toBe(`${redactionMarker} end`);
    // Prefixed names, as in environment files, are assignments too.
    expect(scrubCredentials(["DB_PASS", "WORD=supersecretvalue"].join(""))).toBe(
      `DB_${redactionMarker}`,
    );
    expect(
      scrubCredentials(["GITHUB_TO", "KEN: abcdefghijklmnop"].join("")),
    ).toBe(`GITHUB_${redactionMarker}`);
    expect(scrubCredentials(["my_api", "_key=abcdefghijk"].join(""))).toBe(
      `my_${redactionMarker}`,
    );
    // Common compound names, in snake case, camel case and JSON.
    expect(scrubCredentials(["SECRET", "_KEY=abcdefghijk"].join(""))).toBe(
      redactionMarker,
    );
    expect(
      scrubCredentials(['{"access', 'Token":"abcdefghijk"}'].join("")),
    ).toBe(`{"${redactionMarker}}`);
    expect(scrubCredentials(["refresh", "Token: abcdefghijk"].join(""))).toBe(
      redactionMarker,
    );
    // A keyword glued to letters or digits is another word.
    expect(scrubCredentials("mytoken=abcdefghijk")).toBe("mytoken=abcdefghijk");
    // A short closed quote is not a credential value by this rule.
    expect(scrubCredentials('pwd="short" plan')).toBe('pwd="short" plan');
  });

  test("redacts camelCase names carrying a prefix", () => {
    const marker = redactionMarker;
    const cases: [string, string][] = [
      [["db", "Password=hunter2hunter2"].join(""), `db${marker}`],
      [["db2", "Password: abcdefghij"].join(""), `db2${marker}`],
      [['{"github', 'Token":"abcdefghijk"}'].join(""), `{"github${marker}}`],
      [["my", "ApiKey: abcdefghijk"].join(""), `my${marker}`],
      [["rsa", "PrivateKey=abcdefghijk"].join(""), `rsa${marker}`],
      [["aws", "SecretAccessKey=abcdefghijk"].join(""), `aws${marker}`],
      [["stripe", "ClientSecret: abcdefghijk"].join(""), `stripe${marker}`],
      [["DB", "Password=abcdefghij"].join(""), `DB${marker}`],
      [["JWT", "Secret=abcdefghij"].join(""), `JWT${marker}`],
      [["GCP", "ApiKey: abcdefghij"].join(""), `GCP${marker}`],
      [["bearer", "Token = 'abcdefghij'"].join(""), `bearer${marker}`],
      [["github", "AccessToken=abcdefghijk"].join(""), `github${marker}`],
      [["user", 'Passwd: "correct horse battery" done'].join(""), `user${marker} done`],
    ];
    for (const [input, expected] of cases)
      expect(scrubCredentials(`see ${input}`)).toBe(`see ${expected}`);
  });

  test("keeps camelCase words that are not credential assignments", () => {
    for (const text of [
      "dbPassword reset flow",
      "call setPassword(abcdefghijkl) here",
      "userPassword: short",
      "mytoken=abcdefghijk",
      "Rotate Token: weekly",
    ])
      expect(scrubCredentials(text)).toBe(text);
  });

  test("bounds the code-point conversion of huge text", () => {
    const item = exposeItem(
      "milestones",
      { milestoneId: "m", title: "😀".repeat(500_000), status: "active" },
      ["P", "T"],
    );
    expect(Array.from(item.title as string)).toHaveLength(256);
    expect(item.truncatedFields).toEqual(["title"]);
  });

  test("keeps joiners and direction marks of text without a credential", () => {
    for (const text of [
      "Family 👨‍👩‍👧 offsite",
      "Arabic title ‏مرحبا‏",
      "Soft­hyphen",
    ])
      expect(scrubCredentials(text)).toBe(text);
  });

  test("redacts URL credentials and keeps the host", () => {
    expect(
      scrubCredentials(
        ["see https://alice:", "s3cr3t-pass", "@example.com/x"].join(""),
      ),
    ).toBe(`see ${redactionMarker}example.com/x`);
  });

  test("leaves ordinary planning text alone", () => {
    for (const text of [
      "CB-R10 shared coordination API",
      "Fix the task-sk-board layout",
      "Bearer of bad news",
      "Rotate token: weekly",
      "Password reset flow",
    ])
      expect(scrubCredentials(text)).toBe(text);
  });
});
