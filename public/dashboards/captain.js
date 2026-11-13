export default {
  roleName: 'Barangay Captain',
  navHeading: 'OPERATIONS MENU',
  description: 'Operations view for snapshot reviews, announcements, and team assignments.',
  canReport: false,
  canPublish: true,
  canAssignTasks: true,
  isAdmin: false,
  defaultRoute: '#camera',
  navigation: [
    ['⚠', 'Alerts', '#alerts'],
    ['▣', 'Live camera feed', '#camera'],
    ['&#9654;', 'Recording history', '#recordingHistoryPanel'],
    ['◷', 'Events calendar', '#eventsPanel'],
    ['✓', 'Team tasks', '#tasksPanel']
  ]
};
