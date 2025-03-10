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
import * as winston from 'winston';

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ filename: 'aws-mcp.log' })
  ]
});

// Utility function for retrying AWS API calls
async function retryAwsOperation<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  delay = 1000
): Promise<T> {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      logger.warn(`AWS operation failed (attempt ${attempt}/${maxRetries}): ${error.message}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
      }
    }
  }
  throw lastError;
}

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
        try {
          selectedProfileCredentials = await retryAwsOperation(() => 
            getCredentials(profiles[profileName], profileName)
          );
          selectedProfile = profileName;
          selectedProfileRegion = region || "us-east-1";
        } catch (error) {
          logger.error(`Failed to get credentials for profile ${profileName}:`, error);
          return createTextResponse(`Failed to authenticate with profile ${profileName}: ${error.message}`);
        }
      }

      AWS.config.update({
        region: selectedProfileRegion,
        credentials: selectedProfileCredentials,
      });

      const wrappedCode = wrapUserCode(code);
      const wrappedIIFECode = `(async function() { return (async () => { ${wrappedCode} })(); })()`;
      
      try {
        const result = await runInContext(
          wrappedIIFECode,
          createContext({ AWS })
        );
        return createTextResponse(JSON.stringify(result));
      } catch (error) {
        logger.error(`Code execution error:`, error);
        return createTextResponse(`Error executing code: ${error.message}`);
      }
    } else if (name === "list-credentials") {
      return createTextResponse(
        JSON.stringify({ profiles: Object.keys(profiles), error })
      );
    } else if (name === "select-profile") {
      const { profile, region } = SelectProfileSchema.parse(args);
      try {
        const credentials = await retryAwsOperation(() => 
          getCredentials(profiles[profile], profile)
        );
        selectedProfile = profile;
        selectedProfileCredentials = credentials;
        selectedProfileRegion = region || "us-east-1";
        return createTextResponse("Authenticated!");
      } catch (error) {
        logger.error(`Failed to authenticate with profile ${profile}:`, error);
        return createTextResponse(`Authentication failed: ${error.message}`);
      }
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error(`Error handling tool request:`, error);
    if (error instanceof z.ZodError) {
      return createTextResponse(
        `Invalid arguments: ${error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`
      );
    }
    return createTextResponse(`Error: ${error.message}`);
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
    logger.info('Loading credentials from ini file...');
    credentials = new AWS.IniLoader().loadFrom({});
    logger.info('Loaded credentials:', Object.keys(credentials || {}));
  } catch (error) {
    logger.error('Failed to load credentials:', error);
    error = `Failed to load credentials: ${error}`;
  }
  try {
    logger.info('Loading config from ini file...');
    configs = new AWS.IniLoader().loadFrom({ isConfig: true });
    logger.info('Loaded configs:', Object.keys(configs || {}));
  } catch (error) {
    logger.error('Failed to load configs:', error);
    error = `Failed to load configs: ${error}`;
  }

  const profiles = { ...(credentials || {}), ...(configs || {}) };
  logger.debug('Combined profiles:', Object.keys(profiles));
  logger.debug('Profile details:', JSON.stringify(profiles, null, 2));

  return { profiles, error };
}

async function getCredentials(
  creds: any,
  profileName: string
): Promise<AWS.Credentials | AWS.SSO.RoleCredentials | any> {
  logger.info(`Starting credential load for profile ${profileName}`);
  logger.debug(`Profile config: ${JSON.stringify(creds, null, 2)}`);
  
  if (creds.sso_session) {
    logger.info('SSO session profile detected');
    
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
      
      logger.info(`Found SSO session config. Region: ${ssoRegion}`);
      
      // Ensure SSO cache directory exists
      const ssoDir = `${process.env.HOME}/.aws/sso/cache`;
      try {
        await fs.mkdir(ssoDir, { recursive: true });
      } catch (e) {
        logger.error(`Error creating SSO cache directory: ${e}`);
      }
      
      let validTokenFound = false;
      let validToken = null;
      
      // Try to read SSO token from cache
      try {
        const files = await fs.readdir(ssoDir);
        logger.debug(`Found SSO cache files: ${files.join(', ')}`);
        
        // Read each cache file to find valid token
        for (const file of files) {
          try {
            const content = await fs.readFile(`${ssoDir}/${file}`, 'utf8');
            const cache = JSON.parse(content);
            logger.debug(`Examining cache file ${file}`);
            
            if (cache.startUrl === startUrl && cache.accessToken && cache.expiresAt && new Date(cache.expiresAt) > new Date()) {
              logger.info('Found valid SSO token in cache');
              validTokenFound = true;
              validToken = cache.accessToken;
              break;
            }
          } catch (e) {
            logger.error(`Error reading cache file ${file}: ${e}`);
          }
        }
      } catch (e) {
        logger.error(`Error reading SSO cache directory: ${e}`);
      }
      
      // If no valid token found, initiate SSO login
      if (!validTokenFound) {
        logger.info('No valid token found, initiating SSO login');
        
        try {
          // Run AWS CLI SSO login command
          logger.info(`Running 'aws sso login --profile ${profileName}'`);
          logger.info('Please complete the SSO login in your browser when prompted...');
          
          const { stdout, stderr } = await execPromise(`aws sso login --profile ${profileName}`);
          logger.info(`SSO Login stdout: ${stdout}`);
          if (stderr) logger.warn(`SSO Login stderr: ${stderr}`);
          
          // Check again for valid token after login
          const files = await fs.readdir(ssoDir);
          for (const file of files) {
            try {
              const content = await fs.readFile(`${ssoDir}/${file}`, 'utf8');
              const cache = JSON.parse(content);
              
              if (cache.startUrl === startUrl && cache.accessToken && cache.expiresAt && new Date(cache.expiresAt) > new Date()) {
                logger.info('Found valid SSO token after login');
                validTokenFound = true;
                validToken = cache.accessToken;
                break;
              }
            } catch (e) {
              logger.error(`Error reading cache file ${file} after login: ${e}`);
            }
          }
        } catch (e) {
          logger.error(`Error during SSO login: ${e}`);
        }
      }
      
      // If we have a valid token, get role credentials
      if (validTokenFound && validToken) {
        // Create SSO service with the cached token
        const sso = new AWS.SSO({ region: ssoRegion });
        
        try {
          logger.info('Attempting to get role credentials');
          
          // Use the retry utility for the AWS API call
          const roleCredentials = await retryAwsOperation(() => 
            sso.getRoleCredentials({
              accessToken: validToken,
              accountId: creds.sso_account_id,
              roleName: creds.sso_role_name
            }).promise()
          );
          
          if (!roleCredentials.roleCredentials) {
            throw new Error('No role credentials returned');
          }
          
          const { accessKeyId, secretAccessKey, sessionToken, expiration } = roleCredentials.roleCredentials;
          
          if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) {
            throw new Error('Incomplete role credentials returned');
          }
          
          logger.info('Successfully obtained role credentials');
          return new AWS.Credentials({
            accessKeyId,
            secretAccessKey,
            sessionToken
          });
        } catch (e) {
          logger.error(`Error getting role credentials: ${e}`);
        }
      } else {
        logger.warn('Failed to obtain valid SSO token');
      }
    } catch (e) {
      logger.error(`Error in SSO session handling: ${e}`);
    }
  }
  
  // Fall back to standard credential provider
  logger.info('Falling back to standard credential provider');
  return useAWSCredentialsProvider(profileName);
}

export const useAWSCredentialsProvider = async (
  profileName: string,
  region: string = "us-east-1",
  roleArn?: string
) => {
  logger.info(`Using credential provider for profile ${profileName}`);
  
  try {
    // Try to use AWS SDK v3 credential provider first
    const provider = fromNodeProviderChain({
      clientConfig: { region },
      profile: profileName,
      roleArn
    });
    
    logger.info('Attempting to get credentials from provider chain');
    
    // Use retry mechanism for credential retrieval
    const credentials = await retryAwsOperation(async () => {
      return await provider();
    });
    
    logger.info('Successfully obtained credentials from provider chain');
    
    // Convert v3 credentials to v2 format
    return new AWS.Credentials({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken
    });
  } catch (error) {
    logger.error(`Provider chain error: ${error}`);
    
    // Fall back to AWS SDK v2 credential provider
    try {
      logger.info('Falling back to AWS SDK v2 credential provider');
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
            logger.error(`AWS SDK v2 provider chain error: ${err}`);
            reject(err);
          } else {
            logger.info('Successfully obtained credentials from AWS SDK v2 provider chain');
            resolve(creds);
          }
        });
      });
    } catch (v2Error) {
      logger.error(`AWS SDK v2 provider chain error: ${v2Error}`);
      throw v2Error;
    }
  }
};

// Start the server
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  logger.info("Local Machine MCP Server running on stdio");
});

const createTextResponse = (text: string) => ({
  content: [{ type: "text", text }],
});
