# Contributing to Pane

Thank you for your interest in contributing to Pane! We welcome contributions from the community and are excited to work with you.

Pane is an open source project created by [Dcouple Inc](https://dcouple.ai). Dcouple builds AI software focused on decoupling humans from interfaces to make work feel less like work and more like thought.

## Right to Contribute this Code
- You represent and warrant that You are legally entitled to contribute the code you contribute to Pane
- You represent and warrant that each of Your Contributions is Your original creation. You represent and warrant that, to Your knowledge, none of Your Contributions infringe, violate, or misappropriate any third party intellectual property or other proprietary rights.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally
3. Set up the development environment:
   ```bash
   pnpm run setup
   ```
4. Create a new branch for your feature or bug fix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Process

### Running in Development

```bash
# Run the Electron app in development mode
pnpm dev

# Run tests
pnpm test

# Type checking
pnpm typecheck

# Linting
pnpm lint
```

### Code Style

- We use TypeScript for type safety
- Code is formatted with Prettier (runs automatically on commit)
- ESLint is used for code quality
- Follow the existing code style and patterns

### Project Structure

```
Pane/
├── frontend/         # React renderer process
│   ├── src/
│   │   ├── components/  # UI components
│   │   ├── hooks/       # Custom React hooks
│   │   ├── stores/      # Zustand state stores
│   │   └── utils/       # Utility functions
├── main/            # Electron main process
│   ├── src/
│   │   ├── database/    # SQLite database
│   │   ├── services/    # Business logic
│   │   └── utils/       # Utilities
└── shared/          # Shared types between processes
```

## Making Changes

### Before You Start

1. Check existing issues to avoid duplicates
2. For significant changes, open an issue first to discuss
3. Ensure your branch is up to date with main

### Commit Guidelines

- Write clear, concise commit messages
- Use present tense ("Add feature" not "Added feature")
- Reference issues when applicable (#123)
- Keep commits focused and atomic

Example:
```
Add session status indicators

- Add color-coded badges for session states
- Include animation for running state
- Update types for new status field

Fixes #42
```

### Pull Request Process

1. Update documentation if needed
2. Add tests for new functionality
3. Ensure all tests pass
4. Update the README if adding new features
5. If you've added or updated dependencies:
   - Run `pnpm run generate-notices` to update the NOTICES file
   - Commit the updated NOTICES file with your changes
6. Submit a pull request with:
   - Clear title and description
   - Link to related issues
   - Screenshots for UI changes
   - Testing notes that list the commands you ran

### PR and Release Workflows

Pull requests to `main` run the `Code Quality` workflow. That workflow covers
typecheck, lint, main process tests on Linux/macOS/Windows, frontend unit tests,
and the maintained Playwright smoke suite.

Pushes to `main` run `Code Quality` and `Deploy Remote PWA Preview`. `v*` tags
run `Build & Release` plus website notification. See
[docs/RELEASE_INSTRUCTIONS.md](docs/RELEASE_INSTRUCTIONS.md) before cutting a
release.

## Testing

### Automated Checks

```bash
pnpm typecheck
pnpm lint
pnpm --filter main test
pnpm --filter frontend test
pnpm test:ci:minimal
```

For focused Playwright work, run the relevant spec directly:

```bash
pnpm test -- tests/smoke.spec.ts
pnpm test -- tests/analytics-consent.spec.ts
```

Playwright starts the Electron dev app on port `4521` by default. Do not run
multiple Playwright invocations concurrently on the same port. Run suites
sequentially, or assign separate ports:

```bash
PLAYWRIGHT_PORT=4522 pnpm test -- tests/analytics-consent.spec.ts
```

### Manual Testing Requirements

**IMPORTANT**: Always test your changes in the packaged DMG before submitting a PR. The packaged app often reveals issues that don't appear in development mode.

```bash
# Build the macOS DMG
pnpm build:mac

# Test the DMG located in dist-electron/
```

Manual testing checklist:
- [ ] Create new session
- [ ] Continue existing session
- [ ] Git operations work correctly
- [ ] Run scripts execute properly
- [ ] UI is responsive
- [ ] Settings persist after restart
- [ ] Notifications work (if enabled)
- [ ] **DMG build works correctly** ⚠️

## Reporting Issues

When reporting issues, please include:
- Pane version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if applicable
- Relevant error messages

## Feature Requests

We love hearing ideas for new features! When suggesting features:
- Explain the use case
- Describe the expected behavior
- Consider how it fits with existing features
- Be open to discussion and alternatives

## Code of Conduct

### Our Standards

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Accept constructive criticism gracefully
- Focus on what's best for the community
- Show empathy towards others

### Unacceptable Behavior

- Harassment or discrimination
- Trolling or insulting comments
- Public or private harassment
- Publishing others' private information
- Other unprofessional conduct

## Questions?

Feel free to:
- Open an issue for questions
- Join discussions in existing issues
- Reach out to maintainers

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 License.

Thank you for contributing to Pane! 🎉
