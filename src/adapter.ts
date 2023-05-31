import * as vscode from 'vscode';
import * as glob from 'glob';
import * as fs from 'fs';
import * as readline  from 'readline';
import * as child_process from 'child_process';
import * as path from 'path';

import {
	TestAdapter,
	TestLoadStartedEvent,
	TestLoadFinishedEvent,
	TestRunStartedEvent,
	TestRunFinishedEvent,
	TestSuiteEvent,
	TestEvent,
	TestSuiteInfo,
	TestInfo
} from 'vscode-test-adapter-api';

import { Log } from 'vscode-test-adapter-util';

interface WorkspaceSuiteInfo {
	workspaceName: String;
	workspaceBasePath: String;
	testSuiteInfo: TestSuiteInfo;
}

export class ExampleAdapter implements TestAdapter {

	private disposables: { dispose(): void }[] = [];

	private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
	private readonly testStatesEmitter = new vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
	private readonly autorunEmitter = new vscode.EventEmitter<void>();

	get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> { return this.testsEmitter.event; }
	get testStates(): vscode.Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> { return this.testStatesEmitter.event; }
	get autorun(): vscode.Event<void> | undefined { return this.autorunEmitter.event; }

	private workspaceSuiteInfo: WorkspaceSuiteInfo[] = [];
	private processesRuning: child_process.ChildProcess[] = [];

	private opt_command = "";
	private opt_workdir_relative = "";
	private opt_docker_base_path = "";
	private opt_docker_container_name = "";

	constructor(
		public readonly workspace: vscode.WorkspaceFolder,
		private readonly log: Log
	) {
		this.log.info('Initializing CUnit adapter');

		this.opt_command = this.getConfigurationString('command');
		this.opt_workdir_relative = this.getConfigurationString('workdir_relative');
		this.opt_docker_base_path = this.getConfigurationString('docker_base_path');
		this.opt_docker_container_name = this.getConfigurationString('docker_container_name');

		this.disposables.push(this.testsEmitter);
		this.disposables.push(this.testStatesEmitter);
		this.disposables.push(this.autorunEmitter);

		// callback when a config property is modified
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('unityExplorer.command')) {
				this.opt_command = this.getConfigurationString('command');
			}
			if (event.affectsConfiguration('unityExplorer.workdir_relative')) {
				this.opt_workdir_relative = this.getConfigurationString('workdir_relative');
			}
			if (event.affectsConfiguration('unityExplorer.docker_base_path')) {
				this.opt_docker_base_path = this.getConfigurationString('docker_base_path');
			}
			if (event.affectsConfiguration('unityExplorer.docker_container_name')) {
				this.opt_docker_container_name = this.getConfigurationString('docker_container_name');
			}
			this.load();
		})
	}

	async load(): Promise<void> {

		this.log.info('Loading CUnit tests');

		this.testsEmitter.fire(<TestLoadStartedEvent>{ type: 'started' });

		const loadedTests = await this.loadCUnitTests(this.workspace.name, this.workspace.uri.path);

		var workspaceSuite = this.workspaceSuiteInfo.find(({workspaceName}) => (workspaceName === this.workspace.name));
		if (workspaceSuite) {
			workspaceSuite.testSuiteInfo = loadedTests;
		} else {
			this.workspaceSuiteInfo.push({
				workspaceName: this.workspace.name,
				workspaceBasePath: this.workspace.uri.path,
				testSuiteInfo: loadedTests
			} as WorkspaceSuiteInfo);
		}

		this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', suite: loadedTests });
	}

	async run(tests: string[]): Promise<void> {

		this.log.info(`Running CUnit tests ${JSON.stringify(tests)}`);

		this.runCUnitTests(tests);
	}

/*	implement this method if your TestAdapter supports debugging tests
	async debug(tests: string[]): Promise<void> {
		// start a test run in a child process and attach the debugger to it...
	}
*/

	cancel(): void {
		// in a "real" TestAdapter this would kill the child process for the current test run (if there is any)
		throw new Error("Method not implemented.");
	}

	dispose(): void {
		this.cancel();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
	}

	private getConfiguration(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('cunitExplorer', this.workspace.uri);
	}

	private getConfigurationString(name: string): string {
		const defaultResult = '';
		const result = this.getConfiguration().get<string>(name, defaultResult);
		return result;
	}

	// --------------------------------------------------------------------------------

	async loadCUnitTests(workspaceName: string, workspaceDir: string): Promise<TestSuiteInfo> {
		
		const workspaceInfo: TestSuiteInfo = {
			type: 'suite',
			id: workspaceName,
			label: workspaceName,
			children: []
		};

		const sourceFiles = glob.sync(workspaceDir + '/**/UnitTestFramework/TestCode/*/*Testcase.c');

		for (const testFile of sourceFiles) {

			let regexPattern = workspaceDir + "\\/(.*)\\/UnitTestFramework\\/.*\\/UTC_(\\w*)_Testcase\\.c"
			let testFileRegex = new RegExp(regexPattern);
			let match = testFileRegex.exec(testFile);

			if (match != null) {
			
				let taskName = match[1];
				let testName = match[2];

				var currentTestSuite: TestSuiteInfo;
				var cTS = workspaceInfo.children.find(({ id }) => id === (workspaceName + "." + taskName));
				if (cTS) {
					currentTestSuite = cTS as TestSuiteInfo;
				} else {
					cTS = {
						type: 'suite',
						id: workspaceName + "." + taskName,					
						label: taskName,
						tooltip: workspaceDir + "/" + taskName,
						children: []
					} as TestSuiteInfo;

					workspaceInfo.children.push(cTS);
					currentTestSuite = cTS;
				}

				const testSuite: TestSuiteInfo = {
					type: 'suite',
					id: workspaceName + "." + taskName + "." + testName,
					label: testName,
					tooltip: testFile,
					file: testFile,
					children: []
				};

				const testRegex = new RegExp("^\\s*CU_ADD\\((\\w*)\\)");
				const voidFuncRegex = new RegExp("void\\s*(\\w*)\\s*\\(");

				async function processLineByLine() {

					const fileStream = fs.createReadStream(testFile);
					const rl = readline.createInterface({
						input: fileStream,
						crlfDelay: Infinity
					});

					interface VoidFuncInfo {
						fn: String;
						ln: any;
					}
					var voidFunct: VoidFuncInfo[] = [];
					var lineNo = 0;

					for await (const line of rl) {

						if (voidFuncRegex.test(line)) {
							match = voidFuncRegex.exec(line);
							if (match != null) {
								let testCaseFuncName = match[1];
								
								var lastOccurence = voidFunct.find(({ fn }) => fn === testCaseFuncName);
								if (lastOccurence) {
									lastOccurence.ln = lineNo;
								} else {
									voidFunct.push({
										fn: testCaseFuncName,
										ln: lineNo
									})
								}
							}
						}

						if (testRegex.test(line)) {
							match = testRegex.exec(line);
							if (match != null) {
								let testCaseName = match[1];
								
								var lastOccurenceLineLo = lineNo;
								var lastOccurence = voidFunct.find(({ fn }) => fn === testCaseName);
								if (lastOccurence) {
									lastOccurenceLineLo = lastOccurence.ln;
								}

								testSuite.children.push({
									type: 'test',
									id: workspaceName + "." + taskName + "." + testName + "." + testCaseName,
									label: testCaseName,
									file: testFile,
									line: lastOccurenceLineLo
								} as TestInfo)
							}
						}

						lineNo++;
					}
				}
				
				await processLineByLine();

				currentTestSuite.children.push(testSuite);
			}
		}

		return workspaceInfo;
	}

	async runCUnitTests(suiteOrTestIds: string[]): Promise<void> {

		for (const suiteOrTestId of suiteOrTestIds) {
			for (const taskSuite of this.workspaceSuiteInfo) {
				// run all tests in workplace selected
				if (taskSuite.testSuiteInfo.id == suiteOrTestId) {				
					for (const taskSuiteChild of taskSuite.testSuiteInfo.children) {
						if (taskSuiteChild.type === 'suite') {
							for (const suiteChild of taskSuiteChild.children) {					
								if (suiteChild.type === 'suite') {
									this.runNode(suiteChild, suiteOrTestIds, taskSuite.workspaceBasePath);
								}
							}
						}
					}
				} else {
					for (const taskSuiteChild of taskSuite.testSuiteInfo.children) {					
						if (taskSuiteChild.type === 'suite') {
							// run tests in a task selected
							if (taskSuiteChild.id == suiteOrTestId) {
								for (const suiteChild of taskSuiteChild.children) {					
									if (suiteChild.type === 'suite') {
										this.runNode(suiteChild, suiteOrTestIds, taskSuite.workspaceBasePath);
									}
								}
							} else {
								for (const suiteChild of taskSuiteChild.children) {					
									// run tests group selected
									if (suiteChild.type === 'suite') {
										if (suiteChild.id == suiteOrTestId) {
											this.runNode(suiteChild, suiteOrTestIds, taskSuite.workspaceBasePath);
										} else {
											// run tests group by test selected
											for (const test of suiteChild.children) {
												if ((test.type === 'test') && (test.id == suiteOrTestId)) {
													this.runNode(suiteChild, suiteOrTestIds, taskSuite.workspaceBasePath);
													break;
												}
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}
	}
	
	async runNode(
		node: TestSuiteInfo,
		suiteOrTestIds: string[],
		workspaceBasePath: String
	): Promise<void> {
	
		var self = this;
		
		if (node.file != undefined) {

			var command = this.opt_command.replace("@TESTCASE@", node.label);
			var workdir = path.normalize((path.parse(node.file).dir + this.opt_workdir_relative));

			if (this.opt_docker_container_name != "") {
				var workdirInDocker = workdir.replace(workspaceBasePath.valueOf(), this.opt_docker_base_path.valueOf());				
				command = "docker exec -w \"" + workdirInDocker + "\" " + this.opt_docker_container_name + " bash -c \"" + command + "\"";
			}

			if (self.processesRuning.length == 0) {
				self.testStatesEmitter.fire(<TestRunStartedEvent>{ type: 'started', tests: suiteOrTestIds });
			}
			self.testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'running' });
			for (const testChild of node.children) {
				self.testStatesEmitter.fire(<TestEvent>{ type: 'test', test: testChild.id, state: 'running' });
			}
	
			this.log.info(`Exec: ${command}`);
			const child = child_process.exec(
				command,
				{
					cwd: workdir,
				},			
			);
	
			self.processesRuning.push(child);
	
			const rl  = require('readline').createInterface({ 
				input: child.stdout,
				crlfDelay: Infinity
			});
	
			rl.on('line', function(line: string) {
				for (const testChild of node.children) {
					const testResRegex = new RegExp("Test:\\s*" + testChild.label + "\\s*\\.\\.\\.(\\w*)");
				
					var match = testResRegex.exec(line);
					if (match) {
						if (match[1] == "passed") {
							self.testStatesEmitter.fire(<TestEvent>{ type: 'test', test: testChild.id, state: 'passed' });
						} else {
							self.testStatesEmitter.fire(<TestEvent>{ type: 'test', test: testChild.id, state: 'failed' });
						}
					}
				}
			});
	
			child.on('exit', (code) => {
				if (code != 0) {
					for (const testChild of node.children) {
						self.testStatesEmitter.fire(<TestEvent>{ type: 'test', test: testChild.id, state: 'errored' });
					}				
				}
	
				self.testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'completed' });
	
				const indexChild = self.processesRuning.indexOf(child);
				self.processesRuning.splice(indexChild, 1);
				if (self.processesRuning.length == 0) {
					self.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
				}
	
			});		
		}
	}
	

}
