# AWS Model Context Protocol (MCP) Integration

This project provides a Model Context Protocol (MCP) integration for AWS, allowing you to interact with AWS services through code execution.

## Setup

1. Install dependencies:
```bash
npm install
# or
pnpm install
```

2. Configure AWS SSO:
Make sure you have AWS SSO configured in your `~/.aws/config` file. Example:
```
[profile your-profile]
sso_session = your-session
sso_account_id = 123456789012
sso_role_name = YourRoleName
region = your-region

[sso-session your-session]
sso_start_url = https://your-sso-url.awsapps.com/start
sso_region = your-region
sso_registration_scopes = sso:account:access
```

3. Run the application:
```bash
npm start
# or
pnpm start
```

## Authentication

This application supports AWS SSO authentication. If no valid SSO token is found, it will automatically:
1. Create the necessary SSO cache directory if it doesn't exist
2. Initiate the AWS SSO login process by running `aws sso login --profile <your-profile>`
3. Open a browser window for you to complete the authentication
4. Use the resulting token to authenticate with AWS

## Troubleshooting

If you encounter authentication issues:

1. Manually run AWS SSO login:
```bash
aws sso login --profile your-profile
```

2. Check your AWS configuration:
```bash
aws configure list --profile your-profile
```

3. Verify SSO token cache:
```bash
ls -la ~/.aws/sso/cache
```

4. Check debug logs in the application output for detailed information about the authentication process.