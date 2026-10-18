export default {
  roleName: 'Barangay Captain',
  navHeading: 'OPERATIONS MENU',
  description: 'Operations view for incident reports, announcements, and team assignments.',
  canReport: true,
  canPublish: true,
  canAssignTasks: true,
  isAdmin: false,
  navigation: [
    ['+', 'Report incident', '#quickIncidentPanel'],
    ['▣', 'Live cameras', '#camera'],
    ['▤', 'Incidents', '#incidents'],
    ['◷', 'Announcements', '#announcementsPanel'],
    ['✓', 'Team tasks', '#tasksPanel']
  ]
};
