<!--
name: "Data: Sandbox filesystem disabled setting"
description: "Describes sandbox.filesystem.disabled behavior, platform limits, read-protection effects, and configuration precedence"
ccVersion: "2.1.216"
-->
Sandboxed commands get unrestricted read/write access to the host filesystem; network egress is still confined to network.allowedDomains. Intended for deployments whose goal is egress control rather than filesystem containment. Does not change Bash prompting: sandbox.autoAllowBashIfSandboxed is independent and still defaults to true, so set it to false to keep prompting for sandboxed commands. Drops the read protection from filesystem.denyRead and credentials.files for sandboxed commands, since both are enforced by the filesystem layer this turns off; credentials.envVars deny/mask is unaffected. 
