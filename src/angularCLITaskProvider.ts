import * as vscode from 'vscode';

import * as path from 'path';
import * as fs from 'fs';
import { JSONVisitor, visit } from 'jsonc-parser';

const DEFAULT_NG_BIN_LOCATION = 'node_modules/.bin/ng';

const ANGULAR_CLI_CONF_FILENAMES = ['angular-cli.json', '.angular-cli.json', 'angular.json'];
const TASK_TYPE = 'angularcli';
const TASK_SOURCE = 'Angular CLI';

enum RunOptions {
    Build = 'build',
    BuildWatch = 'build-watch',
    Serve = 'serve',
}

const runOptions = new Map<string, string>([
    [RunOptions.Build, 'Build'],
    [RunOptions.BuildWatch, 'Build (watch)'],
    [RunOptions.Serve, 'Serve'],
]);


async function readFile(file: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		fs.readFile(file, (err, data) => {
			if (err) {
				reject(err);
			}
			resolve(data.toString());
		});
	});
}

async function fileExists(file: string, mode: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        fs.access(file, mode, (error) => {
            resolve(error ? false : true);
        });
    });
}

async function getAngularCLIConfigPath(workspaceFolder: vscode.WorkspaceFolder): Promise<string> {
    return new Promise<string>(async (resolve, reject) => {
        for (let filename of ANGULAR_CLI_CONF_FILENAMES) {
            if (await fileExists(path.join(workspaceFolder.uri.fsPath, filename), fs.constants.F_OK)) {
                resolve(filename);
            }
        }

        reject();
    });
}

interface PartialCustomTask {
    bin?: string;
    args?: string[];
    type: string;
    option: RunOptions;
    angular: string;
    [key: string]: string | string [] | undefined; 
}

const DefinitionFields = [
    'type',
    'option',
    // 'bin',
    // 'args',
    'angular',
];

function optionToParams(option: RunOptions): string[] {
    const args: string[] = [];

    switch (option) {
        case RunOptions.Build:
            args.push('build');
            break;
        case RunOptions.BuildWatch:
            args.push('build', '--watch');
            break;
        case RunOptions.Serve:
            args.push('serve');
            break;
    }

    return args;
}

export class AngularCLITaskProvider implements vscode.TaskProvider {
    async provideTasks(token?: vscode.CancellationToken | undefined): Promise<vscode.Task[]> {
        const folders = vscode.workspace.workspaceFolders;
        const tasks: vscode.Task[] = [];
        
        if (folders && folders.length) {
            const resolved = await Promise.all(
                folders.map( async (folder) => {
                    return await this.getTasks(folder);
                })
            );
            resolved.forEach(result => {
                console.log(result);
                tasks.push(...result);
            });
        }

        return tasks;
    }

    resolveTask(task: vscode.Task, token?: vscode.CancellationToken | undefined): vscode.ProviderResult<vscode.Task> {
        return undefined;
    }

    isAngularCLIProject(folder: vscode.WorkspaceFolder): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            getAngularCLIConfigPath(folder)
                .then(() => resolve(true))
                .catch(() => resolve(false));
        });
    }

    getDefaultTasks(workspaceFolder: vscode.WorkspaceFolder): vscode.Task[] {
        const tasks: vscode.Task[] = [];

        for (let runOption of runOptions) {
            const task = new vscode.Task(
                {
                    type: TASK_TYPE,
                    option: runOption[0],
                    angular: workspaceFolder.name
                },
                workspaceFolder,
                runOption[1],
                TASK_SOURCE,
            );

            if (
                runOption[0] === RunOptions.Serve ||
                runOption[0] === RunOptions.BuildWatch
            ) {
                task.isBackground = true;
            }

            tasks.push(task);
        }

        return tasks;
    }

    async getTasks(workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Task[]> {
        let tasks: vscode.Task[] = [];
        const isAngularCLIProject = await this.isAngularCLIProject(workspaceFolder);

        if (isAngularCLIProject) {
            const defaultTasks = this.getDefaultTasks(workspaceFolder);
            const localNGPath = path.join(workspaceFolder.uri.fsPath, DEFAULT_NG_BIN_LOCATION);
            let suggestedNGBin: string;
            // Suggest to use local ng if detected, else use global
            if (await fileExists(localNGPath, fs.constants.X_OK | fs.constants.F_OK)) {
                suggestedNGBin = localNGPath;
            } else {
                suggestedNGBin = 'ng';
            }

            const customTasks = await this.getCustomTasks(workspaceFolder);
    
            tasks = defaultTasks.map(task => {
                const customTaskIndex = customTasks.findIndex(customTask => {
                    return Object.keys(customTask)
                        .filter(key => DefinitionFields.indexOf(key) !== -1)
                        .every(key => {
                            return (task.definition as any)[key] === customTask[key];
                        });
                });

                if (customTaskIndex !== -1) {
                    const customTask = customTasks[customTaskIndex];
                    Object.keys(customTask)
                        .forEach(key => {
                            task.definition[key] = customTask[key];
                        });
                    customTasks.splice(customTaskIndex, 1);
                    const bin = customTask.bin ? customTask.bin : suggestedNGBin;
                    task.execution = new vscode.ShellExecution(bin, optionToParams(task.definition.option));
                } else {
                    task.execution = new vscode.ShellExecution(suggestedNGBin, optionToParams(task.definition.option));
                }

                return task;
            });

            tasks.push(
                ...customTasks.map(customTask => {
                    const taskDefinition: PartialCustomTask = {
                        type: customTask.type,
                        option: customTask.option,
                        angular: customTask.angular
                    };
                    Object.keys(customTask)
                        .filter(key => {
                            return DefinitionFields.indexOf(key) !== -1;
                        })
                        .forEach(key => {
                        taskDefinition[key] = customTask[key];
                    });
                    const bin = customTask.bin ? customTask.bin : suggestedNGBin;
                    
                    let args = optionToParams(taskDefinition.option);
                    if (customTask.args && customTask.args.length) {
                        args.push(...customTask.args);
                    }

                    const task = new vscode.Task(
                        taskDefinition,
                        workspaceFolder,
                        taskDefinition.option,
                        TASK_SOURCE,
                        new vscode.ShellExecution(bin, args)
                    );

                    if (
                        customTask.option === RunOptions.Serve ||
                        customTask.option === RunOptions.BuildWatch
                    ) {
                        task.isBackground = true;
                    }

                    return task;
                })
            );

        } 
        
        return tasks;
    }
    
    async getCustomTasks(workspaceFolder: vscode.WorkspaceFolder): Promise<PartialCustomTask[]> {
        const tasks: PartialCustomTask[] = [];
        const projectCustomTasksPath = path.join(workspaceFolder.uri.fsPath, '.vscode/tasks.json');

        if (await fileExists(projectCustomTasksPath, fs.constants.F_OK)) {
            const buffer = await readFile(projectCustomTasksPath);
            let inEntry = false;
            let isOurTaskType = false;
            let taskTypeIdentified = false;
            let inTasks = false;
            let currentTaskEntryProperties = new Map<string, any>();
            let currentEntryField: string;
            let taskArgs: string[] | undefined = undefined;
            
            let objectNestingLevel = 0;
        
            let visitor: JSONVisitor = {
                onObjectEnd() {
                    if (inEntry) {
                        if (objectNestingLevel === 0) {
                            inEntry = false;
                            if (isOurTaskType) {
                                let angularWorkspaceFolder = currentTaskEntryProperties.get('angular');
                                if (typeof angularWorkspaceFolder === 'string') {
                                    angularWorkspaceFolder = angularWorkspaceFolder.replace('${workspaceFolder}', workspaceFolder.name);
                                }
                                const task: PartialCustomTask = {
                                    type: TASK_TYPE,
                                    option: currentTaskEntryProperties.get('option'),
                                    bin: currentTaskEntryProperties.get('bin') || undefined,
                                    port: currentTaskEntryProperties.get('port') || undefined,
                                    angular: angularWorkspaceFolder
                                };
    
                                for(let entry of currentTaskEntryProperties.entries()) {
                                    task[entry[0]] = entry[1];
                                }
                                task.angular = angularWorkspaceFolder;
                                
                                tasks.push(task);
                            }
    
                            currentTaskEntryProperties.clear();
                        } else {
                            objectNestingLevel -= 1;
                        }
                    }
                },
                onArrayEnd(offset: number, length: number) {
                    if (!inEntry) {
                        inTasks = false;
                    } else {
                        if (currentEntryField === 'args') {
                            currentTaskEntryProperties.set('args', taskArgs);
                            taskArgs = undefined;
                        }
                    }
                },
                onLiteralValue(value: any, _offset: number, _length: number) {
                    if (inEntry && objectNestingLevel === 0) {
                        if (currentEntryField === 'args') {
                            if (taskArgs === undefined) {
                                taskArgs = [];
                            }
                            taskArgs.push(value);
                        } else {
                            currentTaskEntryProperties.set(currentEntryField, value);
                        }
                        if (currentEntryField === 'type') {
                            taskTypeIdentified = true;
                            isOurTaskType = value === TASK_TYPE ? true : false;
                        } 
                    }
                },
                onObjectProperty(property: string, _offset: number, _length: number) {
                    if (inTasks) {
                        if (
                            !taskTypeIdentified ||
                            (taskTypeIdentified && isOurTaskType)
                        ) {
                            currentEntryField = property;
                        }
                    } else {
                        if (property === 'tasks') {
                            inTasks = true;
                        }
                    }
                },
                onObjectBegin(offset: number, length: number) {
                    if (inEntry) {
                        objectNestingLevel += 1;
                    } else {
                        if (inTasks && !inEntry) {
                            inEntry = true;
                        }
                    }
                }
            };
        
            visit(buffer, visitor);
        }

        return tasks;
    }

}
