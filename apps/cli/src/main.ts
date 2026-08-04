const [command, ...args] = Bun.argv.slice(2);

switch (command) {
  case "status":
    console.log("AI Office blueprint: daemon status not yet implemented");
    break;
  case "project:create":
    console.log("TODO create project", args.join(" "));
    break;
  case "task:create":
    console.log("TODO create task", args);
    break;
  case "task:list":
    console.log("TODO list tasks", args);
    break;
  default:
    console.log(`
AI Office CLI

Commands:
  status
  project:create <name>
  task:create --project <id> --title <title>
  task:list --project <id>
`);
}
