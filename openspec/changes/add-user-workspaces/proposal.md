# Let one user select isolated workspaces in Tau

A user needs one Tau server and several workspaces. Each conversation and file
operation belongs to its workspace, even when the browser selects another one.
run_tau owns workspace configuration, bundle selection, and persistent run records.
Tau reads that information through the existing user socket.

Keep ordinary single-workspace deployments working without bridge configuration.
Do not migrate user data, publish images, or change running services in this change.
