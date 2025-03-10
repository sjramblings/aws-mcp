process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE = "1";

import { Project, SyntaxKind } from "ts-morph";
import { createContext, runInContext } from "node:vm";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as AWS from "aws-sdk";
import open from "open";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const codePrompt = `Your job is to answer questions about AWS environment by writing Javascript code using AWS SDK V2. The code must be adhering to a few rules:
- Must be preferring promises over callbacks
- Think step-by-step before writing the code, approach it logically
- MUST written in Javascript (NodeJS) using AWS-SDK V2
- Avoid hardcoded values like ARNs
- Code written should be as parallel as possible enabling the fastest and the most optimal execution
- Code should be handling errors gracefully, especially when doing multiple SDK calls (e.g. when mapping over an array). Each error should be handled and logged with a reason, script should continue to run despite errors
- DO NOT require or import "aws-sdk", it is already available as "AWS" variable
- Access to 3rd party libraries apart from "aws-sdk" is not allowed or possible
- Data returned from AWS-SDK must be returned as JSON containing only the minimal amount of data that is needed to answer the question. All extra data must be filtered out
- Code MUST "return" a value: string, number, boolean or JSON object. If code does not return anything, it will be considered as FAILED
- Whenever tool/function call fails, retry it 3 times before giving up with an improved version of the code based on the returned feedback
- When listing resources, ensure pagination is handled correctly so that all resources are returned
- Do not include any comments in the code
- When doing reduce, don't forget to provide an initial value
- Try to write code that returns as few data as possible to answer without any additional processing required after the code is run
- This tool can ONLY write code that interacts with AWS. It CANNOT generate charts, tables, graphs, etc. Please use artifacts for that instead
Be concise, professional and to the point. Do not give generic advice, always reply with detailed & contextual data sourced from the current AWS environment. Assume user always wants to proceed, do not ask for confirmation. I'll tip you $200 if you do this right.`;

const server = new Server(
  {
    name: "aws-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

let selectedProfile: string | null = null;
let selectedProfileCredentials: AWS.Credentials | AWS.SSO.RoleCredentials | any;
let selectedProfileRegion: string = "us-east-1";

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "run-aws-code",
        description: "Run AWS code",
        inputSchema: {
          type: "object",
          properties: {
            reasoning: {
              type: "string",
              description: "The reasoning behind the code",
            },
            code: {
              type: "string",
              description: codePrompt,
            },
            profileName: {
              type: "string",
              description: "Name of the AWS profile to use",
            },
            region: {
              type: "string",
              description: "Region to use (if not provided, us-east-1 is used)",
            },
          },
          required: ["reasoning", "code"],
        },
      },
      {
        name: "list-credentials",
        description:
          "List all AWS credentials/configs/profiles that are configured/usable on this machine",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "select-profile",
        description:
          "Selects AWS profile to use for subsequent interactions. If needed, does SSO authentication",
        inputSchema: {
          type: "object",
          properties: {
            profile: {
              type: "string",
              description: "Name of the AWS profile to select",
            },
            region: {
              type: "string",
              description: "Region to use (if not provided, us-east-1 is used)",
            },
          },
          required: ["profile"],
        },
      },
    ],
  };
});

const RunAwsCodeSchema = z.object({
  reasoning: z.string(),
  code: z.string(),
  profileName: z.string().optional(),
  region: z.string().optional(),
});

const SelectProfileSchema = z.object({
  profile: z.string(),
  region: z.string().optional(),
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request, c) => {
  const { name, arguments: args } = request.params;

  try {
    const { profiles, error } = await listCredentials();
    if (name === "run-aws-code") {
      const { reasoning, code, profileName, region } =
        RunAwsCodeSchema.parse(args);
      if (!selectedProfile && !profileName) {
        return createTextResponse(
          `Please select a profile first using the 'select-profile' tool! Available profiles: ${Object.keys(
            profiles
          ).join(", ")}`
        );
      }

      if (profileName) {
        selectedProfileCredentials = await getCredentials(
          profiles[profileName],
          profileName
        );
        selectedProfile = profileName;
        selectedProfileRegion = region || "us-east-1";
      }

      AWS.config.update({
        region: selectedProfileRegion,
        credentials: selectedProfileCredentials,
      });

      const wrappedCode = wrapUserCode(code);
      const wrappedIIFECode = `(async function() { return (async () => { ${wrappedCode} })(); })()`;
      const result = await runInContext(
        wrappedIIFECode,
        createContext({ AWS })
      );

      return createTextResponse(JSON.stringify(result));
    } else if (name === "list-credentials") {
      return createTextResponse(
        JSON.stringify({ profiles: Object.keys(profiles), error })
      );
    } else if (name === "select-profile") {
      const { profile, region } = SelectProfileSchema.parse(args);
      const credentials = await getCredentials(profiles[profile], profile);
      selectedProfile = profile;
      selectedProfileCredentials = credentials;
      selectedProfileRegion = region || "us-east-1";
      return createTextResponse("Authenticated!");
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments: ${error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`
      );
    }
    throw error;
  }
});

function wrapUserCode(userCode: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile("userCode.ts", userCode);
  const lastStatement = sourceFile.getStatements().pop();

  if (
    lastStatement &&
    lastStatement.getKind() === SyntaxKind.ExpressionStatement
  ) {
    const returnStatement = lastStatement.asKind(
      SyntaxKind.ExpressionStatement
    );
    if (returnStatement) {
      const expression = returnStatement.getExpression();
      sourceFile.addStatements(`return ${expression.getText()};`);
      returnStatement.remove();
    }
  }

  return sourceFile.getFullText();
}

async function listCredentials() {
  let credentials: any;
  let configs: any;
  let error: any;
  try {
    console.error('Loading credentials from ini file...');
    credentials = new AWS.IniLoader().loadFrom({});
    console.error('Loaded credentials:', Object.keys(credentials || {}));
  } catch (error) {
    console.error('Failed to load credentials:', error);
    error = `Failed to load credentials: ${error}`;
  }
  try {
    console.error('Loading config from ini file...');
    configs = new AWS.IniLoader().loadFrom({ isConfig: true });
    console.error('Loaded configs:', Object.keys(configs || {}));
  } catch (error) {
    console.error('Failed to load configs:', error);
    error = `Failed to load configs: ${error}`;
  }

  const profiles = { ...(credentials || {}), ...(configs || {}) };
  console.error('Combined profiles:', Object.keys(profiles));
  console.error('Profile details:', JSON.stringify(profiles, null, 2));

  return { profiles, error };
}

async function getCredentials(
  creds: any,
  profileName: string
): Promise<AWS.Credentials | AWS.SSO.RoleCredentials | any> {
  process.stderr.write(`\nDebug: Starting credential load for profile ${profileName}\n`);
  process.stderr.write(`\nDebug: Profile config: ${JSON.stringify(creds, null, 2)}\n`);
  
  if (creds.sso_session) {
    process.stderr.write('\nDebug: SSO session profile detected\n');
    
    try {
      // First try to load the SSO session configuration
      const fs = await import('fs/promises');
      const path = await import('path');
      const { exec } = await import('child_process');
      const util = await import('util');
      const execPromise = util.promisify(exec);
      
      const configContent = await fs.readFile(`${process.env.HOME}/.aws/config`, 'utf8');
      const sessionMatch = configContent.match(new RegExp(`\\[sso-session ${creds.sso_session}\\][^[]*`));
      
      if (!sessionMatch) {
        throw new Error(`SSO session ${creds.sso_session} not found in config`);
      }
      
      const sessionConfig = sessionMatch[0];
      const startUrl = sessionConfig.match(/sso_start_url\s*=\s*(.+)/)?.[1];
      const ssoRegion = sessionConfig.match(/sso_region\s*=\s*(.+)/)?.[1] || creds.region || 'us-east-1';
      
      if (!startUrl) {
        throw new Error('No sso_start_url found in session config');
      }
      
      process.stderr.write(`\nDebug: Found SSO session config. Region: ${ssoRegion}\n`);
      
      // Ensure SSO cache directory exists
      const ssoDir = `${process.env.HOME}/.aws/sso/cache`;
      try {
        await fs.mkdir(ssoDir, { recursive: true });
      } catch (e) {
        process.stderr.write(`\nDebug: Error creating SSO cache directory: ${e}\n`);
      }
      
      let validTokenFound = false;
      let validToken = null;
      
      // Try to read SSO token from cache
      try {
        const files = await fs.readdir(ssoDir);
        process.stderr.write(`\nDebug: Found SSO cache files: ${files.join(', ')}\n`);
        
        // Read each cache file to find valid token
        for (const file of files) {
          try {
            const content = await fs.readFile(`${ssoDir}/${file}`, 'utf8');
            const cache = JSON.parse(content);
            process.stderr.write(`\nDebug: Examining cache file ${file}\n`);
            
            if (cache.startUrl === startUrl && cache.accessToken && cache.expiresAt && new Date(cache.expiresAt) > new Date()) {
              process.stderr.write('\nDebug: Found valid SSO token in cache\n');
              validTokenFound = true;
              validToken = cache.accessToken;
              break;
            }
          } catch (e) {
            process.stderr.write(`\nDebug: Error reading cache file ${file}: ${e}\n`);
          }
        }
      } catch (e) {
        process.stderr.write(`\nDebug: Error reading SSO cache directory: ${e}\n`);
      }
      
      // If no valid token found, initiate SSO login
      if (!validTokenFound) {
        process.stderr.write('\nDebug: No valid token found, initiating SSO login\n');
        
        try {
          // Run AWS CLI SSO login command
          process.stderr.write(`\nDebug: Running 'aws sso login --profile ${profileName}'\n`);
          process.stderr.write('\nPlease complete the SSO login in your browser when prompted...\n');
          
          const { stdout, stderr } = await execPromise(`aws sso login --profile ${profileName}`);
          process.stderr.write(`\nSSO Login stdout: ${stdout}\n`);
          if (stderr) process.stderr.write(`\nSSO Login stderr: ${stderr}\n`);
          
          // Check again for valid token after login
          const files = await fs.readdir(ssoDir);
          for (const file of files) {
            try {
              const content = await fs.readFile(`${ssoDir}/${file}`, 'utf8');
              const cache = JSON.parse(content);
              
              if (cache.startUrl === startUrl && cache.accessToken && cache.expiresAt && new Date(cache.expiresAt) > new Date()) {
                process.stderr.write('\nDebug: Found valid SSO token after login\n');
                validTokenFound = true;
                validToken = cache.accessToken;
                break;
              }
            } catch (e) {
              process.stderr.write(`\nDebug: Error reading cache file ${file} after login: ${e}\n`);
            }
          }
        } catch (e) {
          process.stderr.write(`\nDebug: Error during SSO login: ${e}\n`);
        }
      }
      
      // If we have a valid token, get role credentials
      if (validTokenFound && validToken) {
        // Create SSO service with the cached token
        const sso = new AWS.SSO({ region: ssoRegion });
        
        try {
          process.stderr.write('\nDebug: Attempting to get role credentials\n');
          const roleCredentials = await sso.getRoleCredentials({
            accessToken: validToken,
            accountId: creds.sso_account_id,
            roleName: creds.sso_role_name
          }).promise();
          
          if (!roleCredentials.roleCredentials) {
            throw new Error('No role credentials returned');
          }
          
          const { accessKeyId, secretAccessKey, sessionToken, expiration } = roleCredentials.roleCredentials;
          
          if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) {
            throw new Error('Incomplete role credentials returned');
          }
          
          process.stderr.write('\nDebug: Successfully obtained role credentials\n');
          return new AWS.Credentials({
            accessKeyId,
            secretAccessKey,
            sessionToken
          });
        } catch (e) {
          process.stderr.write(`\nDebug: Error getting role credentials: ${e}\n`);
        }
      } else {
        process.stderr.write('\nDebug: Failed to obtain valid SSO token\n');
      }
    } catch (e) {
      process.stderr.write(`\nDebug: Error in SSO session handling: ${e}\n`);
    }
  }
  
  // Fall back to standard credential provider
  process.stderr.write('\nDebug: Falling back to standard credential provider\n');
  return useAWSCredentialsProvider(profileName);
}

export const useAWSCredentialsProvider = async (
  profileName: string,
  region: string = "us-east-1",
  roleArn?: string
) => {
  process.stderr.write(`\nDebug: Using credential provider for profile ${profileName}\n`);
  
  try {
    // Try to use AWS SDK v3 credential provider first
    const provider = fromNodeProviderChain({
      clientConfig: { region },
      profile: profileName,
      roleArn
    });
    
    process.stderr.write('\nDebug: Attempting to get credentials from provider chain\n');
    const credentials = await provider();
    process.stderr.write('\nDebug: Successfully obtained credentials from provider chain\n');
    
    // Convert v3 credentials to v2 format
    return new AWS.Credentials({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken
    });
  } catch (error) {
    process.stderr.write(`\nDebug: Provider chain error: ${error}\n`);
    
    // Fall back to AWS SDK v2 credential provider
    try {
      process.stderr.write('\nDebug: Falling back to AWS SDK v2 credential provider\n');
      const chain = new AWS.CredentialProviderChain([
        () => new AWS.SharedIniFileCredentials({ profile: profileName }),
        () => new AWS.ProcessCredentials({ profile: profileName }),
        () => new AWS.EnvironmentCredentials('AWS'),
        () => new AWS.EnvironmentCredentials('AMAZON'),
        () => new AWS.EC2MetadataCredentials()
      ]);
      
      return await new Promise((resolve, reject) => {
        chain.resolve((err, creds) => {
          if (err) {
            process.stderr.write(`\nDebug: AWS SDK v2 provider chain error: ${err}\n`);
            reject(err);
          } else {
            process.stderr.write('\nDebug: Successfully obtained credentials from AWS SDK v2 provider chain\n');
            resolve(creds);
          }
        });
      });
    } catch (v2Error) {
      process.stderr.write(`\nDebug: AWS SDK v2 provider chain error: ${v2Error}\n`);
      throw v2Error;
    }
  }
};

// Start the server
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error("Local Machine MCP Server running on stdio");
});

const createTextResponse = (text: string) => ({
  content: [{ type: "text", text }],
});
