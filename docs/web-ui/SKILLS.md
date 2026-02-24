# Steroids Web UI: Skills Management

## Overview
The Skills feature allows developers to define, manage, and share reusable AI behavioral prompts (Skills) directly from the Steroids Web Dashboard. Skills act as modular prompt extensions that can be injected into coder or reviewer workflows.

## Architecture

### Storage
Skills are stored as Markdown (`.md`) files to allow easy version control and readability. 
To prevent git conflicts with the core Web UI repository, skills are divided into two categories:
1. **Pre-installed Skills**: Shipped with the Web UI repository (e.g., `WebUI/src/assets/skills/` or similar).
2. **Custom (User) Skills**: Stored in a global user directory outside the repository (e.g., `~/.steroids/skills/`).

### User Interface (Three-Column Layout)
The Skills section in the Web UI will utilize a three-column layout:
1. **Column 1 (Global Sidebar)**: The existing Steroids Web navigation sidebar, containing the link to the "Skills" section.
2. **Column 2 (Skills List)**: A table/list of all available skills (both pre-installed and custom). It includes a "Create my own" button.
3. **Column 3 (Editor/Viewer)**: 
   - **View Mode**: Displays the selected skill's content, allowing the user to review it.
   - **Edit/Create Mode**: A form with a filename input and a Markdown text area to edit or create custom skills.

## Example Skills

### Pre-installed Skills
1. **HTML & CSS Best Practices (`html-css-best-practices.md`)**: Guidelines for semantic HTML and responsive, vanilla CSS design.

### Custom Skills
1. **500-Line Limit (`500-line-limit.md`)**: Enforces the strict maximum of 500 lines per file.
2. **Adhere to Architecture (`adhere-to-architecture.md`)**: "Do not hallucinate! If you do not know, state that you are hallucinating or missing context rather than inventing APIs. Adhere strictly to the existing project architecture."

## API Requirements (CLI Backend)
To support this in the Web UI, the Steroids CLI API must provide endpoints to:
- `GET /api/skills`: List all skills (merging pre-installed and custom directories).
- `GET /api/skills/:filename`: Retrieve the contents of a specific skill.
- `POST /api/skills`: Create a new custom skill.
- `PUT /api/skills/:filename`: Update an existing custom skill.
- `DELETE /api/skills/:filename`: Delete a custom skill.

## Next Steps
1. Implement the API endpoints in the CLI (`API/src/routes/skills.ts`).
2. Scaffold the new UI layout in the Web UI (`WebUI/src/pages/SkillsPage.tsx`).
3. Create the initial set of Markdown skills.