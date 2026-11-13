export default {
  roleName: 'Tanod',
  navHeading: 'FIELD MENU',
  description: 'Field view for assigned tasks, camera monitoring, alerts, and snapshot alerts.',
  canReport: false,
  canPublish: false,
  canAssignTasks: false,
  isAdmin: false,
  navigation: [
    ['▣', 'Live camera feed', '#camera'],
    ['&#9654;', 'Recording history', '#recordingHistoryPanel'],
    ['⚠', 'Alerts', '#alerts'],
    ['◷', 'Events calendar', '#eventsPanel'],
    ['✓', 'My tasks', '#tasksPanel']
  ]
};
