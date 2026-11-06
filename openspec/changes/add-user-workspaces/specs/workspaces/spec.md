## ADDED Requirements

### Requirement: Workspace isolation

Tau MUST resolve every history and file operation within a registered workspace.
It MUST reject unknown IDs, missing historical workspace identity, paths outside
the root, and symbolic links. A live ID MUST retain its workspace binding.

#### Scenario: A history was copied into another workspace

- **WHEN** both workspaces contain the same Pi session ID
- **THEN** each history can be read, resumed, and deleted independently
- **AND** files in the other workspace remain inaccessible through that identity

### Requirement: Runtime version tracking

Each child MUST receive an independent workspace environment. Startup MUST await
valid ready metadata. Tau MUST distinguish current and actual bundles.

#### Scenario: The workspace bundle changes while Pi is running

- **WHEN** run_tau updates the current bundle
- **THEN** the existing Pi retains its run ID and actual bundle
- **AND** a browser reconnect attaches to that same child
- **AND** new Pi runs use the runtime's newly resolved bundle

### Requirement: Session identity notifications

Tau MUST obtain actual Pi identity after history changes and notify run_tau with
ordered, retryable updates. Tau MUST NOT write persistent run records.

#### Scenario: An extension forks a session

- **WHEN** Pi starts the forked session in the same process
- **THEN** Tau records its actual session ID and mapped history path
- **AND** run_tau receives an identity update for the existing run
- **AND** retries cannot replace a newer identity with an older one

#### Scenario: The runtime cannot acknowledge an update

- **WHEN** Pi has changed history but the control request fails
- **THEN** Tau shows that synchronization is pending and retries
- **AND** Tau does not claim that the Pi operation was rolled back

### Requirement: Standalone compatibility

Ordinary deployments MUST keep their existing HTTP formats and Pi startup.
Bridge mode MUST provide workspace context for model enumeration and export.

#### Scenario: Bridge mode is disabled

- **WHEN** a user creates or resumes a session through the existing API
- **THEN** no workspace ID, socket query, or metadata pipe is required

### Requirement: Shared version 1 control protocol

Tau MUST use workspaces and run-info responses, session-update requests, and
session-updated acknowledgements with seq and session_file. Each UTF-8 NDJSON
frame MUST be at most 262144 bytes including LF. Queries MUST time out after two
seconds. Tau MUST reject invalid fields, versions, encodings, and identities.

#### Scenario: The initial history has not been written yet

- **WHEN** ready confirms the runtime's allocated initial identity at seq 0
- **THEN** Tau uses that persisted identity without submitting an unchanged seq 1
- **AND** later identities wait for a matching history header before submission

#### Scenario: A session update acknowledgement is lost

- **WHEN** three attempts with the same update cannot confirm its acknowledgement
- **THEN** Tau queries run-info to check the exact identity and sequence
- **AND** failure to confirm terminates the initiating run while leaving other runs alone

#### Scenario: A short command reports completion before output finishes

- **WHEN** models or export emits completed on fd 3
- **THEN** Tau waits for stdout to drain and for the process to close
- **AND** validates started, completed, and the exit code before reporting success
