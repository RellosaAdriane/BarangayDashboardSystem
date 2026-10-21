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
    ['\u25b6', 'Past footage', '#recordedFootage'],
    ['▤', 'Incidents', '#incidents'],
    ['◷', 'Events calendar', '#eventsPanel'],
    ['✓', 'Team tasks', '#tasksPanel']
  ]
};
