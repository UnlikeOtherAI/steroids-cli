import React, { useState, useEffect } from 'react';
import { AppShell } from '../components/layouts';
import { PlusIcon, DocumentIcon } from '@heroicons/react/24/outline';
import ReactMarkdown from 'react-markdown';

interface Skill {
  name: string;
  type: 'pre-installed' | 'custom';
}

interface SkillContent extends Skill {
  content: string;
}

export const SkillsPage: React.FC = () => {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillContent | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSkills = async () => {
    setLoading(true);
    try {
      const res = await fetch('http://localhost:3501/api/skills');
      const json = await res.json();
      if (json.success) {
        setSkills(json.data);
      } else {
        setError(json.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchSkillContent = async (name: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`http://localhost:3501/api/skills/${name}`);
      const json = await res.json();
      if (json.success) {
        setSelectedSkill(json.data);
        setIsEditing(false);
      } else {
        setError(json.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const saveSkill = async () => {
    if (!editName || !editContent) return;
    setSaving(true);
    try {
      const res = await fetch(`http://localhost:3501/api/skills/${editName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent }),
      });
      const json = await res.json();
      if (json.success) {
        await fetchSkills();
        fetchSkillContent(editName);
      } else {
        setError(json.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    fetchSkills();
  }, []);

  return (
    <AppShell title="AI Skills Management">
      <div className="flex h-full min-h-[600px] overflow-hidden">
        {/* Left Column: List */}
        <div className="w-1/3 border-r border-border flex flex-col bg-bg-surface2">
          <div className="p-4 border-b border-border flex justify-between items-center">
            <h2 className="text-lg font-semibold text-text-primary">All Skills</h2>
            <button
              onClick={() => {
                setSelectedSkill(null);
                setEditName('');
                setEditContent('');
                setIsEditing(true);
              }}
              className="p-2 bg-accent text-white rounded-lg hover:bg-accent-hover flex items-center gap-1 text-sm"
            >
              <PlusIcon className="w-4 h-4" /> Create
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {skills.map(s => (
              <div
                key={s.name}
                onClick={() => fetchSkillContent(s.name)}
                className={`p-4 border-b border-border cursor-pointer hover:bg-bg-surface transition-colors ${selectedSkill?.name === s.name && !isEditing ? 'bg-bg-surface border-l-4 border-l-accent' : ''}`}
              >
                <div className="flex items-center gap-3">
                  <DocumentIcon className="w-5 h-5 text-text-secondary" />
                  <div>
                    <h3 className="text-md font-medium text-text-primary">{s.name}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${s.type === 'custom' ? 'bg-success-soft text-success' : 'bg-info-soft text-info'}`}>
                      {s.type}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right Column: Editor/Viewer */}
        <div className="flex-1 flex flex-col bg-bg-surface">
          {error && (
            <div className="m-4 p-4 bg-danger-soft text-danger rounded-lg text-sm">{error}</div>
          )}

          {isEditing ? (
            <div className="flex-1 flex flex-col p-6">
              <h2 className="text-xl font-bold mb-4 text-text-primary">Create / Edit Custom Skill</h2>
              <input
                type="text"
                placeholder="Skill filename (e.g. strict-typing)"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                disabled={selectedSkill?.type === 'pre-installed'}
                className="mb-4 p-3 border border-border rounded-lg bg-bg-elevated text-text-primary"
              />
              <textarea
                placeholder="Markdown content for your skill..."
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                className="flex-1 p-4 border border-border rounded-lg bg-bg-elevated text-text-primary font-mono text-sm resize-none"
              />
              <div className="mt-4 flex justify-end gap-3">
                <button
                  onClick={() => setIsEditing(false)}
                  className="px-6 py-2 border border-border rounded-lg text-text-secondary hover:bg-bg-surface2"
                >
                  Cancel
                </button>
                <button
                  onClick={saveSkill}
                  disabled={saving || !editName || !editContent}
                  className="px-6 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Skill'}
                </button>
              </div>
            </div>
          ) : selectedSkill ? (
            <div className="flex-1 flex flex-col">
              <div className="p-4 border-b border-border flex justify-between items-center bg-bg-surface2">
                <div>
                  <h2 className="text-xl font-bold text-text-primary">{selectedSkill.name}.md</h2>
                  <span className="text-sm text-text-secondary">{selectedSkill.type} skill</span>
                </div>
                {selectedSkill.type === 'custom' && (
                  <button
                    onClick={() => {
                      setEditName(selectedSkill.name);
                      setEditContent(selectedSkill.content);
                      setIsEditing(true);
                    }}
                    className="px-4 py-2 bg-bg-elevated border border-border rounded-lg text-sm text-text-primary hover:shadow-card"
                  >
                    Edit Skill
                  </button>
                )}
              </div>
              <div className="p-8 flex-1 overflow-y-auto prose prose-invert max-w-none text-text-primary">
                <ReactMarkdown>{selectedSkill.content}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-text-muted">
              Select a skill from the list or create a new one.
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
};